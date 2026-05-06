import { Shape } from "../../api/templates";
import { filterCss } from "./SlotDesigner";
import {
  offsetPolygonPx,
  pointsToClipPath,
  pointsToPx,
  pointsToSvg,
} from "../../utils/polygon";

export type SlotPlacement = {
  /** URL of the artwork thumbnail to render inside the slot. */
  thumbnailUrl?: string | null;
  /** Rotation in degrees (CSS rotation; positive = clockwise). */
  rotationDeg?: number;
  /** Sequence number for the badge (1-indexed). */
  number?: number;
  /** Fit mode. "manual" = use mm coords below; otherwise contain/cover/stretch. */
  fitMode?: "contain" | "cover" | "stretch" | "manual";
  /** Slot-local placement in mm (origin = slot top-left). Only used when
   *  fitMode === "manual". Negative or oversized values opt into bleed. */
  xMm?: number;
  yMm?: number;
  wMm?: number | null;
  hMm?: number | null;
  /** Visual filter id (matches `FILTER_PRESETS` in SlotDesigner). */
  filterId?: string;
  /** Asset's natural physical size in mm. When provided AND `fitMode` is
   *  "contain" (the default for newly-placed assets), the overlay renders
   *  the artwork at this size centred in the slot - so a 58×88 mm playing
   *  card looks identical here to how the SlotDesigner shows it. Without
   *  this, `object-fit: contain` shrinks the entire source PDF (including
   *  any whitespace built into the artboard) to fit the slot, which makes
   *  the visible artwork look much smaller than the cut line. */
  assetNaturalWmm?: number;
  assetNaturalHmm?: number;
};

type Props = {
  shapes: Shape[];
  pageWidthPt: number;
  pageHeightPt: number;
  /** Render scale: pixels per PDF point. */
  scale: number;
  /** Optional: shape_index -> assigned slot number for highlighting. */
  slotNumbers?: Record<number, number>;
  /** Optional: shape_index -> placement (artwork preview + rotation). */
  placements?: Record<number, SlotPlacement>;
  /** When true and there's no placement, show a subtle dashed outline. */
  highlightEmpty?: boolean;
  /** When true, draw the slot bounding rectangles. Default: true. */
  showSlotOutlines?: boolean;
  /** Bleed in PDF points. Drawn as a red dashed rect outside each slot. */
  bleedPt?: number;
  /** Safe-zone in PDF points. Drawn as a blue dashed rect inside each slot. */
  safePt?: number;
  onShapeClick?: (shape: Shape, e: React.MouseEvent<SVGElement>) => void;
};

export default function SlotOverlay({
  shapes,
  pageWidthPt,
  pageHeightPt,
  scale,
  slotNumbers,
  placements,
  highlightEmpty,
  showSlotOutlines = true,
  bleedPt = 0,
  safePt = 0,
  onShapeClick,
}: Props) {
  const bleedPx = bleedPt * scale;
  const safePx = safePt * scale;
  const w = pageWidthPt * scale;
  const h = pageHeightPt * scale;

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ width: w, height: h }}
    >
      {/* Artwork preview layer (HTML images so we get proper transparency
          and CSS rotation). Each artwork is wrapped in a per-slot clip
          box sized to slot + bleed - that way the user can drag/scale
          the image into legitimate bleed area but it can never visually
          encroach on neighbouring slots, matching what the press will
          actually print after the cut. */}
      {placements &&
        shapes.map((s) => {
          const p = placements[s.shape_index];
          if (!p?.thumbnailUrl) return null;
          const [x, y, sw, sh] = s.bbox;
          const rot = ((p.rotationDeg || 0) % 360 + 360) % 360;
          // PT per mm = 72/25.4. Slot bbox is in PDF points.
          const ptPerMm = 72 / 25.4;

          // Clip box covers slot + bleed on every side. Image left/top
          // are then expressed relative to this clip box rather than
          // the overlay so its overflow:hidden actually catches them.
          const slotPx = x * scale;
          const slotPy = y * scale;
          const slotPw = sw * scale;
          const slotPh = sh * scale;
          const clipLeft = slotPx - bleedPx;
          const clipTop = slotPy - bleedPx;
          const clipW = slotPw + bleedPx * 2;
          const clipH = slotPh + bleedPx * 2;
          // Match the bleed-outline corner-radius logic so the clip
          // hugs exactly what the dashed bleed rect shows.
          const rPx = Math.max(
            0,
            Math.min(
              (s.corner_radius_pt || 0) * scale,
              Math.min(slotPw, slotPh) / 2
            )
          );
          const wrapperRadius =
            s.kind === "ellipse"
              ? "50%"
              : rPx > 0
              ? `${rPx + bleedPx}px`
              : 0;
          // For polygon slots, clip the artwork preview to the polygon
          // (expanded by the bleed). The wrapper div is sized to the
          // slot+bleed box, so the polygon vertices need to be
          // *re-normalised* to that expanded box rather than the raw
          // slot bbox - otherwise the clip would chop off the bleed
          // strip the user can legitimately drag artwork into.
          let clipPath: string | undefined;
          if (s.kind === "polygon" && s.path && s.path.length >= 3) {
            const slotPts = pointsToPx(s.path, slotPx, slotPy, slotPw, slotPh);
            const expanded = offsetPolygonPx(slotPts, bleedPx);
            const reNorm: [number, number][] = expanded.map(([x, y]) => [
              clipW > 0 ? (x - clipLeft) / clipW : 0,
              clipH > 0 ? (y - clipTop) / clipH : 0,
            ]);
            clipPath = pointsToClipPath(reNorm);
          }

          let imgLeft: number;
          let imgTop: number;
          let widthPx: number;
          let heightPx: number;
          let objectFit: "contain" | "fill" | "cover" = "contain";
          if (
            p.fitMode === "manual" &&
            p.wMm != null &&
            p.hMm != null &&
            p.wMm > 0 &&
            p.hMm > 0
          ) {
            imgLeft = (x + (p.xMm || 0) * ptPerMm) * scale - clipLeft;
            imgTop = (y + (p.yMm || 0) * ptPerMm) * scale - clipTop;
            widthPx = p.wMm * ptPerMm * scale;
            heightPx = p.hMm * ptPerMm * scale;
            objectFit = "fill";
          } else if (
            (p.fitMode === "contain" || p.fitMode === undefined) &&
            p.assetNaturalWmm &&
            p.assetNaturalHmm &&
            p.assetNaturalWmm > 0 &&
            p.assetNaturalHmm > 0
          ) {
            // Render the asset at its native physical size, centred on the
            // slot — but if the asset is drastically larger (raster photos),
            // contain-fit so it doesn't just overflow+clip and look like an
            // unintentional full-bleed.
            let natW = p.assetNaturalWmm * ptPerMm * scale;
            let natH = p.assetNaturalHmm * ptPerMm * scale;
            if (natW > slotPw * 1.5 || natH > slotPh * 1.5) {
              const ar = natW / natH;
              natW = slotPw;
              natH = slotPw / ar;
              if (natH > slotPh) {
                natH = slotPh;
                natW = slotPh * ar;
              }
            }
            imgLeft = slotPx + (slotPw - natW) / 2 - clipLeft;
            imgTop = slotPy + (slotPh - natH) / 2 - clipTop;
            widthPx = natW;
            heightPx = natH;
            objectFit = "fill";
          } else {
            imgLeft = slotPx - clipLeft;
            imgTop = slotPy - clipTop;
            widthPx = slotPw;
            heightPx = slotPh;
            objectFit =
              p.fitMode === "cover"
                ? "cover"
                : p.fitMode === "stretch"
                ? "fill"
                : "contain";
          }
          return (
            <div
              key={`art-${s.shape_index}`}
              style={{
                position: "absolute",
                left: clipLeft,
                top: clipTop,
                width: clipW,
                height: clipH,
                overflow: "hidden",
                borderRadius: clipPath ? 0 : wrapperRadius,
                clipPath,
                WebkitClipPath: clipPath,
                // iOS Safari refuses to paint a freshly-decoded <img> inside
                // an overflow:hidden + border-radius/clip-path wrapper until
                // something forces a composite of that region. Without this
                // hint the image only appears once the user rotates (which
                // mutates `transform` on the inner img and triggers a repaint).
                // Promoting the wrapper to its own GPU layer gives iOS a
                // stable surface to paint into the moment the asset loads.
                transform: "translateZ(0)",
                WebkitTransform: "translateZ(0)",
                willChange: "transform",
              }}
            >
              <img
                src={p.thumbnailUrl}
                alt=""
                draggable={false}
                decoding="async"
                loading="eager"
                style={{
                  position: "absolute",
                  left: imgLeft,
                  top: imgTop,
                  width: widthPx,
                  height: heightPx,
                  objectFit,
                  // translate3d nudges the rotation onto the GPU compositor
                  // so the *initial* paint also lands - rotate() alone is
                  // sometimes treated as a 2D-only transform on iOS and
                  // skips the composite hint we want here.
                  transform: `translate3d(0,0,0) rotate(${rot}deg)`,
                  transformOrigin: "center center",
                  userSelect: "none",
                  WebkitUserSelect: "none",
                  filter: filterCss(p.filterId),
                }}
              />
            </div>
          );
        })}

      <svg
        className="absolute inset-0"
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{ overflow: "visible" }}
      >
        <defs>
          <linearGradient id="slotBadgeGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a855f7" />
            <stop offset="100%" stopColor="#6366f1" />
          </linearGradient>
          <filter id="slotBadgeShadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="1" stdDeviation="1.2" floodColor="#0f172a" floodOpacity="0.45" />
          </filter>
        </defs>
        {shapes.map((s) => {
          const [x, y, sw, sh] = s.bbox;
          const px = x * scale;
          const py = y * scale;
          const pw = sw * scale;
          const ph = sh * scale;
          const cx = px + pw / 2;
          const cy = py + ph / 2;
          const slotNum = slotNumbers?.[s.shape_index];
          const placement = placements?.[s.shape_index];
          const numbered = slotNum !== undefined;
          const hasArt = !!placement?.thumbnailUrl;

          const badgeR = Math.max(9, Math.min(pw, ph) * 0.18);
          const fontSize = badgeR * 1.05;
          // Corner radius in render pixels (only meaningful for rect kinds).
          const rPx = Math.max(
            0,
            Math.min((s.corner_radius_pt || 0) * scale, Math.min(pw, ph) / 2)
          );
          // Polygon vertex coords in pixel space, plus the bleed-expanded
          // and safe-inset variants. We compute them once per slot so the
          // four cut/click/bleed/safe branches below stay readable.
          const isPoly = s.kind === "polygon" && !!s.path && s.path.length >= 3;
          const polyPx = isPoly
            ? pointsToPx(s.path as [number, number][], px, py, pw, ph)
            : null;
          const polyBleedSvg = polyPx && bleedPx > 0
            ? pointsToSvg(offsetPolygonPx(polyPx, bleedPx))
            : null;
          const polyCutSvg = polyPx ? pointsToSvg(polyPx) : null;
          const polySafeSvg = polyPx && safePx > 0
            ? pointsToSvg(offsetPolygonPx(polyPx, -safePx))
            : null;

          return (
            <g
              key={s.shape_index}
              className={onShapeClick ? "pointer-events-auto cursor-pointer" : undefined}
              onClick={onShapeClick ? (e) => onShapeClick(s, e) : undefined}
            >
              {/* Slot outline. The underlying PDF already shows the slot
                  shape; we only add an SVG outline when we need to communicate
                  state the PDF can't (e.g. "this slot is empty" via
                  `highlightEmpty`, or a transparent click target for
                  interaction). For numbered slots the gradient badge is the
                  indicator - drawing another outline on top of an already-
                  visible PDF circle/rect just looks like a duplicate ghost
                  shape. */}
              {showSlotOutlines && !numbered && highlightEmpty && (
                isPoly && polyCutSvg ? (
                  <polygon
                    points={polyCutSvg}
                    fill="rgba(34, 211, 238, 0.05)"
                    stroke="rgba(34, 211, 238, 0.7)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ) : s.kind === "ellipse" ? (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={pw / 2}
                    ry={ph / 2}
                    fill="rgba(34, 211, 238, 0.05)"
                    stroke="rgba(34, 211, 238, 0.7)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                ) : (
                  <rect
                    x={px}
                    y={py}
                    width={pw}
                    height={ph}
                    rx={rPx}
                    ry={rPx}
                    fill="rgba(34, 211, 238, 0.05)"
                    stroke="rgba(34, 211, 238, 0.7)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                )
              )}
              {/* Invisible click target so onShapeClick still fires when we
                  skip the outline (covers the whole slot area). */}
              {showSlotOutlines && onShapeClick && (numbered || !highlightEmpty) && (
                isPoly && polyCutSvg ? (
                  <polygon
                    points={polyCutSvg}
                    fill="rgba(0,0,0,0.001)"
                    stroke="none"
                  />
                ) : s.kind === "ellipse" ? (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={pw / 2}
                    ry={ph / 2}
                    fill="rgba(0,0,0,0.001)"
                    stroke="none"
                  />
                ) : (
                  <rect
                    x={px}
                    y={py}
                    width={pw}
                    height={ph}
                    rx={rPx}
                    ry={rPx}
                    fill="rgba(0,0,0,0.001)"
                    stroke="none"
                  />
                )
              )}
              {bleedPx > 0 && (
                isPoly && polyBleedSvg ? (
                  <polygon
                    points={polyBleedSvg}
                    fill="rgba(244, 63, 94, 0.08)"
                    stroke="rgba(244, 63, 94, 0.95)"
                    strokeWidth={1.4}
                    strokeDasharray="5 3"
                    pointerEvents="none"
                  />
                ) : s.kind === "ellipse" ? (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={pw / 2 + bleedPx}
                    ry={ph / 2 + bleedPx}
                    fill="rgba(244, 63, 94, 0.08)"
                    stroke="rgba(244, 63, 94, 0.95)"
                    strokeWidth={1.4}
                    strokeDasharray="5 3"
                    pointerEvents="none"
                  />
                ) : (
                  <rect
                    x={px - bleedPx}
                    y={py - bleedPx}
                    width={pw + bleedPx * 2}
                    height={ph + bleedPx * 2}
                    rx={rPx > 0 ? rPx + bleedPx : 0}
                    ry={rPx > 0 ? rPx + bleedPx : 0}
                    fill="rgba(244, 63, 94, 0.08)"
                    stroke="rgba(244, 63, 94, 0.95)"
                    strokeWidth={1.4}
                    strokeDasharray="5 3"
                    pointerEvents="none"
                  />
                )
              )}
              {safePx > 0 && pw > safePx * 2 && ph > safePx * 2 && (
                isPoly && polySafeSvg ? (
                  <polygon
                    points={polySafeSvg}
                    fill="none"
                    stroke="rgba(56, 189, 248, 0.9)"
                    strokeWidth={1.2}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                ) : s.kind === "ellipse" ? (
                  <ellipse
                    cx={cx}
                    cy={cy}
                    rx={pw / 2 - safePx}
                    ry={ph / 2 - safePx}
                    fill="none"
                    stroke="rgba(56, 189, 248, 0.9)"
                    strokeWidth={1.2}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                ) : (
                  <rect
                    x={px + safePx}
                    y={py + safePx}
                    width={pw - safePx * 2}
                    height={ph - safePx * 2}
                    rx={rPx > 0 ? Math.max(0, rPx - safePx) : 0}
                    ry={rPx > 0 ? Math.max(0, rPx - safePx) : 0}
                    fill="none"
                    stroke="rgba(56, 189, 248, 0.9)"
                    strokeWidth={1.2}
                    strokeDasharray="3 3"
                    pointerEvents="none"
                  />
                )
              )}
              {numbered && (
                <g filter="url(#slotBadgeShadow)" opacity={hasArt ? 0.9 : 1}>
                  <circle
                    cx={hasArt ? px + badgeR + 4 : cx}
                    cy={hasArt ? py + badgeR + 4 : cy}
                    r={badgeR}
                    fill="url(#slotBadgeGrad)"
                  />
                  <text
                    x={hasArt ? px + badgeR + 4 : cx}
                    y={hasArt ? py + badgeR + 4 : cy}
                    textAnchor="middle"
                    dominantBaseline="central"
                    fontFamily="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
                    fontSize={fontSize}
                    fontWeight={700}
                    fill="#ffffff"
                    style={{ letterSpacing: "-0.02em" }}
                  >
                    {slotNum}
                  </text>
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
