import { useEffect, useRef, useState } from "react";
import {
  hexToRgb,
  rgbCss,
  rgbToHex,
  type RGB,
} from "../../api/colorProfiles";

type Props = {
  value: RGB;
  onChange: (rgb: RGB) => void;
  /** When provided, shown above the inputs as the "before" swatch.
   *  Useful for color swap rows where the user can see source vs target. */
  source?: RGB;
  /** Optional label for the picker. */
  label?: string;
  /** Optional native color input integration so the user gets the OS picker
   *  too. Default: true. */
  showSystemPicker?: boolean;
  /** Source-mode safety net: when this picker is editing a SWAP SOURCE
   *  (i.e. a colour that needs to literally exist in the artwork), pass
   *  the list of colours actually detected in the artwork. The picker
   *  will:
   *    - warn if `value` doesn't exactly match any detected colour
   *    - offer a one-click "snap to closest detected" affordance
   *    - render swatches the user can click to set the value exactly
   *  This kills the most common failure mode (user types a hex that
   *  drifts by 1-2 channels from the real colour and no swap fires). */
  detectedForSnap?: RGB[];
};

/**
 * Adobe-style RGB picker. Three integer inputs (0..255) for R/G/B plus a
 * hex input that mirrors them. Optionally shows the source colour as a
 * "before" swatch and an arrow.
 *
 * The OS-native colour picker is wired through a hidden `<input type=color>`
 * so users on macOS/Windows can grab colours from anywhere on screen if
 * they want - the manual RGB inputs remain authoritative.
 */
export default function RgbColorPicker({
  value,
  onChange,
  source,
  label,
  showSystemPicker = true,
  detectedForSnap,
}: Props) {
  const [hexDraft, setHexDraft] = useState(rgbToHex(value).replace(/^#/, ""));
  const nativeRef = useRef<HTMLInputElement | null>(null);

  // Keep the hex draft in sync if `value` changes externally.
  useEffect(() => {
    setHexDraft(rgbToHex(value).replace(/^#/, ""));
  }, [value]);

  function setChannel(idx: 0 | 1 | 2, raw: string) {
    const n = Math.max(0, Math.min(255, parseInt(raw || "0", 10) || 0));
    const next: RGB = [...value] as RGB;
    next[idx] = n;
    onChange(next);
  }

  function commitHex(next: string) {
    const parsed = hexToRgb(next);
    if (parsed) onChange(parsed);
    else setHexDraft(rgbToHex(value).replace(/^#/, ""));
  }

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-950/50 p-3 space-y-3">
      {label && (
        <div className="text-xs text-neutral-400 font-medium">{label}</div>
      )}

      {/* Swatches: source -> target, or just target */}
      <div className="flex items-center gap-2">
        {source && (
          <>
            <div
              className="h-10 w-10 rounded-md border border-neutral-700 shadow-inner"
              style={{ backgroundColor: rgbCss(source) }}
              title={`Source ${rgbToHex(source)}`}
            />
            <div className="text-neutral-500 text-sm">→</div>
          </>
        )}
        <button
          type="button"
          onClick={() => nativeRef.current?.click()}
          className="h-10 w-10 rounded-md border border-neutral-700 shadow-inner ring-1 ring-black/10 hover:ring-violet-500/40 transition"
          style={{ backgroundColor: rgbCss(value) }}
          title="Open system colour picker"
        />
        {showSystemPicker && (
          <input
            ref={nativeRef}
            type="color"
            value={rgbToHex(value)}
            onChange={(e) => {
              const parsed = hexToRgb(e.target.value);
              if (parsed) onChange(parsed);
            }}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
          />
        )}
        <div className="ml-auto text-xs text-neutral-500 font-mono">
          {rgbToHex(value)}
        </div>
      </div>

      {/* RGB integer inputs (Adobe layout) */}
      <div className="grid grid-cols-3 gap-2">
        {(["R", "G", "B"] as const).map((label, idx) => (
          <label
            key={label}
            className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 focus-within:border-violet-500"
          >
            <span className="text-xs font-semibold text-neutral-400 w-3">
              {label}
            </span>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={value[idx as 0 | 1 | 2]}
              onChange={(e) =>
                setChannel(idx as 0 | 1 | 2, e.target.value.replace(/[^0-9]/g, ""))
              }
              className="w-full bg-transparent text-sm font-mono outline-none text-right"
              maxLength={3}
            />
          </label>
        ))}
      </div>

      {/* Hex input mirroring */}
      <label className="flex items-center gap-1.5 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-1.5 focus-within:border-violet-500">
        <span className="text-xs font-semibold text-neutral-400">#</span>
        <input
          type="text"
          value={hexDraft}
          onChange={(e) =>
            setHexDraft(e.target.value.replace(/[^0-9a-fA-F]/g, "").toUpperCase().slice(0, 6))
          }
          onBlur={(e) => commitHex(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitHex((e.target as HTMLInputElement).value);
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="w-full bg-transparent text-sm font-mono outline-none uppercase tracking-wider"
          spellCheck={false}
          autoCapitalize="characters"
          autoCorrect="off"
          maxLength={6}
        />
      </label>

      {detectedForSnap && detectedForSnap.length > 0 && (
        <DetectedSnap
          value={value}
          detected={detectedForSnap}
          onPick={onChange}
        />
      )}
    </div>
  );
}

/**
 * Source-side helper: shows the user the colours actually present in
 * the artwork and warns when their typed value doesn't match any of
 * them. One click snaps to the nearest detected colour - the only way
 * to GUARANTEE the swap will fire when generating, since we use exact-
 * match (per the user's spec - no fuzzy tolerance).
 */
function DetectedSnap({
  value,
  detected,
  onPick,
}: {
  value: RGB;
  detected: RGB[];
  onPick: (rgb: RGB) => void;
}) {
  const exactMatch = detected.some(
    (d) => d[0] === value[0] && d[1] === value[1] && d[2] === value[2]
  );
  // Distance in channels (Manhattan); good enough to recommend a snap.
  let nearest: RGB | null = null;
  let nearestDist = Infinity;
  for (const d of detected) {
    const dist =
      Math.abs(d[0] - value[0]) + Math.abs(d[1] - value[1]) + Math.abs(d[2] - value[2]);
    if (dist < nearestDist) {
      nearestDist = dist;
      nearest = d;
    }
  }

  return (
    <div
      className={`rounded-lg border p-2.5 space-y-2 ${
        exactMatch
          ? "border-emerald-500/30 bg-emerald-500/5"
          : "border-amber-500/40 bg-amber-500/5"
      }`}
    >
      {exactMatch ? (
        <div className="text-[11px] text-emerald-300 leading-snug">
          ✓ This source matches a colour in your artwork — the swap will fire.
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="text-[11px] text-amber-200 leading-snug">
            ⚠ This source colour does NOT exist in the artwork (matching is
            exact). The swap will not fire. Pick one of the detected
            colours below:
          </div>
          {nearest && nearestDist <= 12 && (
            <button
              type="button"
              onClick={() => onPick(nearest!)}
              className="w-full rounded-md border border-amber-500/50 bg-amber-500/10 hover:bg-amber-500/20 transition px-2 py-1.5 text-[11px] text-amber-100 flex items-center gap-2"
            >
              <span
                className="h-4 w-4 rounded border border-black/30"
                style={{ backgroundColor: rgbCss(nearest) }}
              />
              <span className="font-mono">{rgbToHex(nearest)}</span>
              <span className="text-amber-300/70">
                — snap to closest (off by {nearestDist})
              </span>
            </button>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {detected.map((d) => {
          const isCurrent =
            d[0] === value[0] && d[1] === value[1] && d[2] === value[2];
          return (
            <button
              key={d.join(",")}
              type="button"
              onClick={() => onPick(d)}
              className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-mono transition ${
                isCurrent
                  ? "border-emerald-500 bg-emerald-500/10"
                  : "border-neutral-700 bg-neutral-900 hover:border-violet-500"
              }`}
              title={`Use ${rgbToHex(d)}`}
            >
              <span
                className="h-3 w-3 rounded-sm border border-black/30"
                style={{ backgroundColor: rgbCss(d) }}
              />
              <span className="text-neutral-300">{rgbToHex(d)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
