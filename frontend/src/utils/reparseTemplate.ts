import { reparseTemplate, Template } from "../api/templates";

/**
 * Bump this whenever `backend/services/pdf_parser.py` changes in a way
 * that would meaningfully alter slot bboxes for previously-uploaded
 * templates. Pages that show slot overlays call `autoReparseIfStale`
 * on load; if the template hasn't been re-parsed at the current
 * version yet, we trigger a one-shot re-parse so the user doesn't
 * have to remember to click anything.
 *
 * v2: switched from PyMuPDF's stroke-padded `drawing["rect"]` to
 *     the geometric bbox derived from the path's `items`, plus
 *     CropBox-origin offsetting.
 *
 * v3: removed the legacy y-flip - PyMuPDF returns drawings in
 *     top-left coords, the same frame the SVG/PDF.js overlay uses,
 *     so the bbox needs to flow through verbatim. v2 still inverted
 *     y, which left every imported PDF mis-aligned to the visible
 *     cut lines. Also dedupes overlapping duplicate paths that some
 *     Illustrator round-trips emit.
 *
 * v4: rounded rectangles now classify as `kind: "rect"` (with the
 *     measured `corner_radius_pt` attached) instead of being
 *     misread as ellipses because of their corner beziers. Without
 *     this, the editable area in the designer was an axis-aligned
 *     ellipse on top of a rounded-rect cut line.
 *
 * v5: closed straight-line paths with 3+ vertices that aren't an
 *     axis-aligned rectangle now classify as `kind: "polygon"` and
 *     carry a normalised `path` of vertices. Without this, hexagons
 *     / octagons / stars / custom die-cut shapes parsed as plain
 *     rectangles, so the editor's pink cut line was a bbox square
 *     and dropped artwork wasn't clipped to the actual cut shape.
 */
export const PARSER_VERSION = 5;

const STORAGE_PREFIX = "printlay.parsedAt.";

function storageKey(templateId: string): string {
  return `${STORAGE_PREFIX}${templateId}`;
}

function readVersion(templateId: string): number {
  try {
    return parseInt(localStorage.getItem(storageKey(templateId)) || "0", 10);
  } catch {
    return 0;
  }
}

function writeVersion(templateId: string, version: number): void {
  try {
    localStorage.setItem(storageKey(templateId), String(version));
  } catch {
    /* localStorage unavailable, fine */
  }
}

/**
 * Reparse `tpl` if it's an uploaded template that hasn't been parsed
 * by the current `PARSER_VERSION` yet. Returns the (possibly new)
 * template, or the same one if no reparse was needed / it failed.
 *
 * Generated templates are skipped because their shapes come straight
 * from `pdf_generator` and don't benefit from re-parsing the PDF.
 */
export async function autoReparseIfStale(
  tpl: Template
): Promise<Template> {
  if (tpl.source !== "uploaded") return tpl;
  if (readVersion(tpl.id) >= PARSER_VERSION) return tpl;
  try {
    const updated = await reparseTemplate(tpl.id);
    writeVersion(tpl.id, PARSER_VERSION);
    return updated;
  } catch {
    // If the reparse fails (e.g. source PDF gone, network issue) we
    // silently fall back to the existing data rather than blocking
    // the page. The user can still hit "Re-detect slots" manually.
    return tpl;
  }
}
