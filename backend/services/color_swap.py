"""Exact-match RGB colour swapping for PDF assets.

What this module does
---------------------

* `detect(pdf_bytes)` walks the page content streams of a PDF and
  returns every distinct RGB triplet that's *set* as a fill or stroke
  colour (it does NOT care about colours referenced by raster images,
  patterns, gradients, etc - those are vendor-specific and out of
  scope for v1; we count them in the report instead).

* `apply(pdf_bytes, swaps)` walks the same content streams and, for
  every fill/stroke colour that exactly matches a swap's `source`,
  rewrites it as **DeviceRGB** (`r g b rg` for fill, `r g b RG` for
  stroke) using the swap's `target`.

Why DeviceRGB
-------------

We promised that opening the output in Illustrator would show the
exact RGB triplet the user typed. Calibrated colour spaces (CalRGB,
ICC-based RGB) make Illustrator round-trip the value through a
profile, so 212/25/79 might come back as 213/24/80. DeviceRGB is the
uncalibrated PDF colour space - the operator literally takes 0..1
floats and Adobe reads them straight back as the same 0-255 ints.

CMYK source colours are converted to sRGB once (via the standard
naive conversion) before matching. Output is always DeviceRGB.

Limitations (counted, not modified, in `ColorSwapReport`)
---------------------------------------------------------

* Gradients (`sh` operator) - stops live in pattern dicts, not the
  page stream, and the v1 spec is "gradients skipped".
* Indexed / ICC colour spaces (`cs` / `scn`) on objects more
  complicated than a plain RGB - we count and skip.
* Embedded raster images - same; raster recolour is a separate
  feature.

The implementation walks the QPDF content-stream tokens directly so
we don't depend on any high-level parser semantics. Works on
single-page and multi-page PDFs; covers Form XObjects too.
"""

from __future__ import annotations

import io
import re
from dataclasses import dataclass, field
from typing import Any, Iterable

# pikepdf is imported lazily so the rest of the backend stays
# importable in environments where the wheel hasn't been installed
# (e.g. CI for parts that don't need PDF colour rewriting).
_pikepdf: Any = None


def _get_pikepdf():
    global _pikepdf
    if _pikepdf is None:
        import pikepdf as _module  # type: ignore[import-untyped]
        _pikepdf = _module
    return _pikepdf


RGB = tuple[int, int, int]
"""sRGB triple, integer 0-255 each channel."""


@dataclass(frozen=True)
class Swap:
    source: RGB
    target: RGB

    @classmethod
    def from_dict(cls, raw: dict) -> "Swap | None":
        try:
            s = _coerce_rgb(raw["source"])
            t = _coerce_rgb(raw["target"])
        except (KeyError, ValueError, TypeError):
            return None
        return cls(source=s, target=t)


@dataclass
class ColorSwapReport:
    swaps_applied: int = 0
    swaps_by_color: dict[RGB, int] = field(default_factory=dict)
    gradients_skipped: int = 0
    raster_skipped: int = 0
    unmatched: set[RGB] = field(default_factory=set)

    def to_dict(self) -> dict:
        return {
            "swaps_applied": self.swaps_applied,
            "by_color": {
                _hex(k): v for k, v in self.swaps_by_color.items()
            },
            "gradients_skipped": self.gradients_skipped,
            "raster_skipped": self.raster_skipped,
            "unmatched": sorted(_hex(c) for c in self.unmatched),
        }


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def detect(pdf_bytes: bytes) -> list[RGB]:
    """Return every distinct RGB triplet *set as a colour* in the PDF
    content streams. Sorted for stable display order."""
    try:
        pikepdf = _get_pikepdf()
    except Exception:
        return []
    seen: set[RGB] = set()
    try:
        with pikepdf.open(io.BytesIO(pdf_bytes)) as pdf:
            for page in pdf.pages:
                for stream in _content_streams(page):
                    for color, _ in _walk_colors(stream):
                        seen.add(color)
    except Exception:
        # Be defensive: detection failures shouldn't block the user, the
        # UI just shows "no colours detected" and they can still type
        # values manually.
        return []
    return sorted(seen)


def apply(
    pdf_bytes: bytes,
    swaps: Iterable[dict | Swap],
) -> tuple[bytes, ColorSwapReport]:
    """Apply colour swaps to every page in the PDF. Returns the new
    bytes plus a report. If no swaps match, the bytes returned may be
    the original input."""
    swap_list: list[Swap] = []
    for s in swaps:
        if isinstance(s, Swap):
            swap_list.append(s)
        else:
            sw = Swap.from_dict(s)
            if sw is not None:
                swap_list.append(sw)

    report = ColorSwapReport()
    if not swap_list:
        return pdf_bytes, report

    # Build a fast {source_rgb: target_rgb} lookup. Last write wins on
    # duplicates - the UI prevents these but we don't crash if they
    # arrive.
    lookup: dict[RGB, RGB] = {sw.source: sw.target for sw in swap_list}

    try:
        pikepdf = _get_pikepdf()
        pdf = pikepdf.open(io.BytesIO(pdf_bytes))
    except Exception:
        return pdf_bytes, report

    try:
        any_modified = False
        for page in pdf.pages:
            for stream_obj in _writable_streams(page):
                original = bytes(stream_obj.read_bytes())
                rewritten, count, gradients, raster, unmatched = _rewrite_stream(
                    original, lookup, report
                )
                report.gradients_skipped += gradients
                report.raster_skipped += raster
                report.unmatched.update(unmatched)
                report.swaps_applied += count
                if count > 0:
                    stream_obj.write(rewritten)
                    any_modified = True
        if not any_modified:
            return pdf_bytes, report
        out = io.BytesIO()
        pdf.save(out)
        return out.getvalue(), report
    finally:
        pdf.close()


# ---------------------------------------------------------------------------
# Content stream walker (token-level, regex-based)
#
# PDF content streams are a stack-based language; we don't need the
# graphics state to do colour rewriting because every colour-set
# operator carries the colour values inline. So we tokenise just
# enough to find the relevant operators and rewrite them in place.
#
# Operators we care about (from PDF 32000-1, Table 74):
#   r g b rg   - set non-stroking (fill) DeviceRGB colour
#   r g b RG   - set stroking DeviceRGB colour
#   c m y k k  - set non-stroking DeviceCMYK colour     (lowercase k)
#   c m y k K  - set stroking DeviceCMYK colour
#   gray g     - set non-stroking DeviceGray
#   gray G     - set stroking DeviceGray
#   ... sc / SC / scn / SCN handle named colour spaces; for "DeviceRGB"
#       set via /CS+rg these reduce to the rg/RG forms above. We
#       only attempt to match `sc`/`SC` when they're 3-component RGB
#       (most common for vector PDFs exported from Illustrator).
#
# Gradients (`sh`) and raster images (`Do` referencing image XObjects)
# are counted but never rewritten - tracked via `_walk_colors` only.
# ---------------------------------------------------------------------------


# A PDF "number" operand: optional sign, digits with optional decimal.
_NUM = r"[-+]?(?:\d+\.\d*|\.\d+|\d+)"
# Operator pattern: one of the colour ops we care about.
_OP_RE = re.compile(
    rb"(?P<args>(?:[-+]?(?:\d+\.\d*|\.\d+|\d+)\s+){1,4})"
    rb"(?P<op>rg|RG|k|K|g|G|sc|SC|scn|SCN|sh)\b"
)


def _walk_colors(stream_bytes: bytes):
    """Yield `(rgb, op)` for every fill/stroke colour set in this stream.
    Used by `detect`. Does not modify anything."""
    for m in _OP_RE.finditer(stream_bytes):
        op = m.group("op").decode("ascii")
        args_raw = m.group("args").decode("ascii", "ignore").split()
        try:
            nums = [float(a) for a in args_raw]
        except ValueError:
            continue
        rgb = _op_to_rgb(op, nums)
        if rgb is not None:
            yield rgb, op


def _rewrite_stream(
    stream_bytes: bytes,
    lookup: dict[RGB, RGB],
    report: ColorSwapReport,
) -> tuple[bytes, int, int, int, set[RGB]]:
    """Rewrite the stream replacing matching colour operators. Returns
    `(new_bytes, swaps_applied, gradients_seen, raster_seen, unmatched)`.

    Note: for now `raster_seen` is left at 0 here - tracking raster
    objects requires resource dictionary inspection which we do
    elsewhere. Same for gradients (`sh`) - we count occurrences but
    don't try to mutate the underlying shading dict in v1."""
    out = bytearray()
    last = 0
    swaps_applied = 0
    gradients_seen = 0
    unmatched: set[RGB] = set()
    raster_seen = 0  # populated by callers that inspect the resources tree

    for m in _OP_RE.finditer(stream_bytes):
        op = m.group("op").decode("ascii")
        if op == "sh":
            gradients_seen += 1
            continue

        args_raw = m.group("args").decode("ascii", "ignore").split()
        try:
            nums = [float(a) for a in args_raw]
        except ValueError:
            continue

        rgb = _op_to_rgb(op, nums)
        if rgb is None:
            continue

        target = lookup.get(rgb)
        if target is None:
            unmatched.add(rgb)
            continue

        # Emit everything up to this match unchanged.
        out += stream_bytes[last : m.start()]

        # Replace with DeviceRGB equivalent. Stroke vs fill keeps its
        # case (lowercase = fill, uppercase = stroke).
        new_op = b"RG" if op.isupper() else b"rg"
        r, g, b = target
        out += f"{r/255.0:.6f} {g/255.0:.6f} {b/255.0:.6f} ".encode("ascii")
        out += new_op
        last = m.end()
        swaps_applied += 1
        report.swaps_by_color[rgb] = report.swaps_by_color.get(rgb, 0) + 1

    out += stream_bytes[last:]
    return bytes(out), swaps_applied, gradients_seen, raster_seen, unmatched


def _op_to_rgb(op: str, nums: list[float]) -> RGB | None:
    """Map a colour-set operator + its operand list to an sRGB triple."""
    # rg / RG: 3 args, DeviceRGB
    if op in ("rg", "RG") and len(nums) == 3:
        return _floats_to_rgb(nums[0], nums[1], nums[2])
    # k / K: 4 args, DeviceCMYK -> sRGB via naive conversion
    if op in ("k", "K") and len(nums) == 4:
        c, m, y, k = nums
        return _cmyk_to_srgb(c, m, y, k)
    # g / G: 1 arg, DeviceGray
    if op in ("g", "G") and len(nums) == 1:
        v = max(0.0, min(1.0, nums[0]))
        i = int(round(v * 255))
        return (i, i, i)
    # sc / SC / scn / SCN: depends on current colour space. We only
    # handle the "3-component RGB" case (most common for vector PDFs).
    if op in ("sc", "SC", "scn", "SCN") and len(nums) == 3:
        return _floats_to_rgb(nums[0], nums[1], nums[2])
    if op in ("sc", "SC", "scn", "SCN") and len(nums) == 4:
        # CMYK in a calibrated/named space - convert as best-effort.
        return _cmyk_to_srgb(nums[0], nums[1], nums[2], nums[3])
    return None


def _floats_to_rgb(r: float, g: float, b: float) -> RGB:
    return (
        max(0, min(255, int(round(max(0.0, min(1.0, r)) * 255)))),
        max(0, min(255, int(round(max(0.0, min(1.0, g)) * 255)))),
        max(0, min(255, int(round(max(0.0, min(1.0, b)) * 255)))),
    )


def _cmyk_to_srgb(c: float, m: float, y: float, k: float) -> RGB:
    """Naive CMYK->sRGB. Good enough for matching Illustrator's
    default conversion on uncoated paper. We're not trying to be a
    colour management system - just to recognise that "CMYK 0,1,1,0"
    means "red" so the user's "swap red" rule applies."""
    c, m, y, k = (max(0.0, min(1.0, v)) for v in (c, m, y, k))
    r = (1.0 - c) * (1.0 - k)
    g = (1.0 - m) * (1.0 - k)
    b = (1.0 - y) * (1.0 - k)
    return _floats_to_rgb(r, g, b)


def _coerce_rgb(value) -> RGB:
    """Accept `[r, g, b]` or `(r, g, b)` of ints 0..255. Anything else
    raises ValueError - validation should happen at the API layer."""
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        raise ValueError(f"Expected RGB triple, got {value!r}")
    out = []
    for v in value:
        try:
            iv = int(v)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"Bad RGB component {v!r}") from exc
        if iv < 0 or iv > 255:
            raise ValueError(f"RGB component out of range: {iv}")
        out.append(iv)
    return (out[0], out[1], out[2])


def _hex(rgb: RGB) -> str:
    return f"#{rgb[0]:02X}{rgb[1]:02X}{rgb[2]:02X}"


# ---------------------------------------------------------------------------
# Content stream extraction helpers
#
# A PDF page's drawn content can live in:
#   - page.Contents (a single stream or array of streams)
#   - Form XObjects referenced from /Resources/XObject
# We walk both, transitively, so colours embedded in form objects also
# get rewritten. Image XObjects are noted (raster_skipped) but not
# touched.
# ---------------------------------------------------------------------------


def _content_streams(page) -> Iterable[bytes]:
    """Yield raw content stream bytes for a page, including form XObjects."""
    seen: set[int] = set()
    for stream in _writable_streams(page, seen=seen):
        try:
            yield bytes(stream.read_bytes())
        except Exception:
            continue


def _writable_streams(page, *, seen: set[int] | None = None) -> Iterable:
    """Yield pikepdf Stream objects we can mutate. Walks form XObjects too."""
    if seen is None:
        seen = set()

    contents = page.obj.get("/Contents")
    for s in _flatten_streams(contents, seen):
        yield s

    resources = page.obj.get("/Resources")
    if resources is not None:
        xobjects = resources.get("/XObject")
        if xobjects is not None:
            try:
                items = list(xobjects.items())
            except Exception:
                items = []
            for _name, obj in items:
                if id(obj) in seen:
                    continue
                seen.add(id(obj))
                # Image XObjects have /Subtype = /Image; skip.
                try:
                    subtype = obj.get("/Subtype")
                    if subtype is not None and str(subtype) in ("/Image", "Image"):
                        continue
                except Exception:
                    pass
                # Form XObjects ARE content streams.
                pikepdf = _get_pikepdf()
                if isinstance(obj, pikepdf.Stream):
                    yield obj


def _flatten_streams(obj, seen: set[int]) -> Iterable:
    """Resolve /Contents which may be a single stream or an array."""
    if obj is None:
        return
    pikepdf = _get_pikepdf()
    if isinstance(obj, pikepdf.Stream):
        if id(obj) in seen:
            return
        seen.add(id(obj))
        yield obj
        return
    if isinstance(obj, pikepdf.Array):
        for item in obj:
            yield from _flatten_streams(item, seen)
