/**
 * Visual preview of cutter registration marks, drawn in millimetre space so
 * it can overlay any page/artboard at the right scale. Mirrors the shapes the
 * backend bakes into output PDFs (`services/job_registration.py` /
 * `sheet_compositor`) so what you see on the template is what the cutter gets.
 *
 * Render inside a positioned container whose aspect ratio matches
 * `widthMm / heightMm`; this SVG fills it via `position:absolute; inset:0`.
 */
export type RegistrationType = "velloblade" | "summa_opos" | "generic";

const OFFSET_MM = 5;

export default function RegistrationMarksOverlay({
  registrationType,
  widthMm,
  heightMm,
  maxZoneMm,
  color = "#111827",
}: {
  registrationType: RegistrationType | "" | null;
  widthMm: number;
  heightMm: number;
  maxZoneMm?: number | null;
  color?: string;
}) {
  if (!registrationType || widthMm <= 0 || heightMm <= 0) return null;

  const w = widthMm;
  const h = heightMm;
  const off = OFFSET_MM;
  const els: React.ReactNode[] = [];

  const zones =
    maxZoneMm && maxZoneMm > 0 ? Math.max(1, Math.ceil(h / maxZoneMm)) : 1;
  const zoneH = h / zones;

  if (registrationType === "velloblade") {
    const r = 3; // 6mm diameter
    for (let z = 0; z < zones; z++) {
      const top = z * zoneH;
      const bottom = Math.min((z + 1) * zoneH, h);
      const centres: [number, number][] = [
        [off, top + off],
        [w - off, top + off],
        [off, bottom - off],
        [w - off, bottom - off],
        [w / 2, top + off],
      ];
      centres.forEach(([cx, cy], i) => {
        els.push(
          <circle key={`v${z}-${i}`} cx={cx} cy={cy} r={r} fill={color} />
        );
      });
    }
  } else if (registrationType === "summa_opos") {
    const arm = 1.5;
    const ys: number[] = [];
    for (let i = 0; i <= zones; i++) {
      if (i === 0) ys.push(off);
      else if (i === zones) ys.push(h - off);
      else ys.push(i * zoneH);
    }
    ys.forEach((y, yi) =>
      [off, w - off].forEach((x, xi) => {
        els.push(
          <line
            key={`sh${yi}-${xi}`}
            x1={x - arm}
            y1={y}
            x2={x + arm}
            y2={y}
            stroke={color}
            strokeWidth={0.4}
          />,
          <line
            key={`sv${yi}-${xi}`}
            x1={x}
            y1={y - arm}
            x2={x}
            y2={y + arm}
            stroke={color}
            strokeWidth={0.4}
          />
        );
      })
    );
  } else {
    // generic
    const arm = 2;
    const corners: [number, number][] = [
      [off, off],
      [w - off, off],
      [off, h - off],
      [w - off, h - off],
    ];
    corners.forEach(([cx, cy], i) => {
      els.push(
        <line
          key={`gh${i}`}
          x1={cx - arm}
          y1={cy}
          x2={cx + arm}
          y2={cy}
          stroke={color}
          strokeWidth={0.4}
        />,
        <line
          key={`gv${i}`}
          x1={cx}
          y1={cy - arm}
          x2={cx}
          y2={cy + arm}
          stroke={color}
          strokeWidth={0.4}
        />,
        <circle
          key={`gc${i}`}
          cx={cx}
          cy={cy}
          r={arm * 0.6}
          fill="none"
          stroke={color}
          strokeWidth={0.3}
        />
      );
    });
  }

  return (
    <svg
      className="absolute inset-0 pointer-events-none"
      width="100%"
      height="100%"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {els}
    </svg>
  );
}
