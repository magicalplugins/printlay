/**
 * Polygon geometry helpers shared by SlotOverlay and SlotDesigner.
 *
 * Vertices are stored on `Shape.path` normalised to the slot bbox
 * (`[u, v]` with `u, v` ∈ `[0, 1]`). The renderers convert them to
 * pixel coords and offset them outward (bleed) or inward (safe).
 *
 * The offset uses *centroid scaling*, which is mathematically exact
 * for any regular polygon (hexagon, octagon, etc.) - the dominant
 * use case - and a close approximation for irregular convex shapes.
 * For severely concave or self-intersecting paths it can produce
 * crossing edges; we accept that since the actual cut happens at
 * the press from the original POSITIONS layer, not from the offset
 * preview.
 */

export type Pt = [number, number];

/** Map normalised `[u, v]` vertices into pixel coords inside the slot box. */
export function pointsToPx(
  path: Pt[],
  px: number,
  py: number,
  pw: number,
  ph: number
): Pt[] {
  return path.map(([u, v]) => [px + u * pw, py + v * ph]);
}

/** Format a list of points for SVG `<polygon points="...">`. */
export function pointsToSvg(pts: Pt[]): string {
  return pts.map(([x, y]) => `${x},${y}`).join(" ");
}

/** Format a list of points for CSS `clip-path: polygon(...)` (percentages). */
export function pointsToClipPath(path: Pt[]): string {
  // CSS clip-path expects values relative to the element's box.
  // `path` is already normalised, so multiply by 100 for percent.
  const inner = path.map(([u, v]) => `${(u * 100).toFixed(4)}% ${(v * 100).toFixed(4)}%`).join(", ");
  return `polygon(${inner})`;
}

/**
 * Offset a polygon outward by `dPx` pixels (use a negative value to
 * inset). Implemented as scale-from-centroid using the apothem of a
 * regular polygon with the same number of vertices, which gives an
 * exact `dPx` edge offset for every regular polygon.
 */
export function offsetPolygonPx(pts: Pt[], dPx: number): Pt[] {
  if (dPx === 0 || pts.length < 3) return pts;
  const n = pts.length;
  const cx = pts.reduce((a, p) => a + p[0], 0) / n;
  const cy = pts.reduce((a, p) => a + p[1], 0) / n;
  const avgR =
    pts.reduce((a, p) => a + Math.hypot(p[0] - cx, p[1] - cy), 0) / n;
  if (avgR <= 0) return pts;
  // Apothem of a regular n-gon = circumradius * cos(π/n). Solving for
  // a scale that moves every edge outward by exactly `dPx`:
  //   factor = (apothem + dPx) / apothem
  const apothem = avgR * Math.cos(Math.PI / n);
  if (apothem <= 0) return pts;
  const factor = (apothem + dPx) / apothem;
  return pts.map(
    ([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor] as Pt
  );
}
