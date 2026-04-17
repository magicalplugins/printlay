import { Shape } from "../../api/templates";

type Props = {
  shapes: Shape[];
  pageWidthPt: number;
  pageHeightPt: number;
  /** Render scale: pixels per PDF point. */
  scale: number;
  /** Optional: shape_index -> assigned slot number for highlighting. */
  slotNumbers?: Record<number, number>;
  onShapeClick?: (shape: Shape, e: React.MouseEvent<SVGElement>) => void;
};

export default function SlotOverlay({
  shapes,
  pageWidthPt,
  pageHeightPt,
  scale,
  slotNumbers,
  onShapeClick,
}: Props) {
  const w = pageWidthPt * scale;
  const h = pageHeightPt * scale;

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
    >
      {shapes.map((s) => {
        const [x, y, sw, sh] = s.bbox;
        const px = x * scale;
        const py = y * scale;
        const pw = sw * scale;
        const ph = sh * scale;
        const slotNum = slotNumbers?.[s.shape_index];
        const numbered = slotNum !== undefined;
        return (
          <g
            key={s.shape_index}
            className={onShapeClick ? "pointer-events-auto cursor-pointer" : undefined}
            onClick={onShapeClick ? (e) => onShapeClick(s, e) : undefined}
          >
            <rect
              x={px}
              y={py}
              width={pw}
              height={ph}
              fill={numbered ? "rgba(245, 158, 11, 0.18)" : "rgba(99, 102, 241, 0.10)"}
              stroke={numbered ? "rgb(245, 158, 11)" : "rgba(255,255,255,0.35)"}
              strokeWidth={numbered ? 2 : 1}
            />
            {numbered && (
              <text
                x={px + pw / 2}
                y={py + ph / 2 + 5}
                textAnchor="middle"
                fontFamily="ui-monospace, monospace"
                fontSize={Math.min(pw, ph) * 0.4}
                fontWeight="700"
                fill="rgb(245, 158, 11)"
              >
                {slotNum}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
