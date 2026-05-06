import { FormEvent, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  GenerateRequest,
  SpacingMode,
  generateTemplate,
  uploadTemplate,
} from "../api/templates";
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import { formatApiError, FormattedApiError } from "../utils/apiError";

type Path = "choose" | "upload" | "generate";

export default function TemplateWizard() {
  const [path, setPath] = useState<Path>("choose");

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 overflow-x-hidden">
      <div className="mb-8 sm:mb-10">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">New template</h1>
        <p className="text-neutral-400 mt-1 text-sm sm:text-base">
          Two ways in: bring your own, or build one here.
        </p>
      </div>

      {path === "choose" && <Choose onPick={setPath} />}
      {path === "upload" && <UploadStep onBack={() => setPath("choose")} />}
      {path === "generate" && <GenerateStep onBack={() => setPath("choose")} />}
    </div>
  );
}

function Choose({ onPick }: { onPick: (p: Path) => void }) {
  return (
    <div className="grid md:grid-cols-2 gap-5">
      <Card
        title="Upload your template"
        body="Drop in an Illustrator-exported PDF. We'll preserve your artboard exactly and detect slots on a POSITIONS layer."
        cta="Upload AI/PDF"
        onClick={() => onPick("upload")}
      />
      <Card
        title="Generate one here"
        body="Specify the artboard, the shape (rectangle, circle, or oval), and the gap. We auto-fit and centre the grid for you."
        cta="Build a template"
        onClick={() => onPick("generate")}
      />
    </div>
  );
}

function Card({
  title,
  body,
  cta,
  onClick,
}: {
  title: string;
  body: string;
  cta: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left rounded-2xl border border-neutral-800 bg-neutral-900/50 p-7 hover:border-neutral-500 transition group"
    >
      <div className="text-2xl font-bold">{title}</div>
      <p className="text-neutral-400 mt-2">{body}</p>
      <div className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-white">
        {cta} <span className="transition group-hover:translate-x-1">→</span>
      </div>
    </button>
  );
}

function UploadStep({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const tpl = await uploadTemplate(file, name || file.name);
      navigate(`/app/templates/${tpl.id}`);
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-6 max-w-xl">
      <BackLink onBack={onBack} />
      <div>
        <label className="block text-sm font-medium text-neutral-300 mb-2">PDF file</label>
        <input
          type="file"
          accept="application/pdf,.pdf,.ai"
          required
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-neutral-300
            file:mr-4 file:rounded-lg file:border-0 file:bg-white file:px-4 file:py-2.5
            file:text-sm file:font-semibold file:text-neutral-950
            hover:file:bg-neutral-200"
        />
        <p className="text-xs text-neutral-500 mt-2">
          Tip: in Illustrator, put your slot shapes (rectangles, ovals, hexagons,
          stars — any closed path) on a layer named{" "}
          <code className="text-neutral-300">POSITIONS</code> before exporting.
        </p>
      </div>
      <div>
        <label className="block text-sm font-medium text-neutral-300 mb-2">Name</label>
        <input
          type="text"
          placeholder="e.g. Greetings Card 40-up"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 outline-none focus:border-neutral-600"
        />
      </div>
      <QuotaErrorBanner error={err} />
      <button
        type="submit"
        disabled={!file || busy}
        className="rounded-lg bg-white px-6 py-3 font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
      >
        {busy ? "Uploading…" : "Upload + parse"}
      </button>
    </form>
  );
}

function GenerateStep({ onBack }: { onBack: () => void }) {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [units, setUnits] = useState<"mm" | "in" | "pt">("mm");
  const [aw, setAw] = useState(297);
  const [ah, setAh] = useState(210);
  // "oval" covers both circle (locked) and ellipse (unlocked).
  const [shapeFamily, setShapeFamily] = useState<"oval" | "rect">("oval");
  const [locked, setLocked] = useState(true); // true = circle (equal W/H)
  const [sw, setSw] = useState(55);
  const [sh, setSh] = useState(55);

  // Derived kind sent to the backend.
  const kind: "circle" | "ellipse" | "rect" =
    shapeFamily === "rect" ? "rect" : locked ? "circle" : "ellipse";

  function pickFamily(next: "oval" | "rect") {
    setShapeFamily(next);
    if (next === "oval" && locked) {
      const d = Math.min(sw, sh) || sw || 55;
      setSw(d);
      setSh(d);
    }
  }

  function toggleLock() {
    const next = !locked;
    setLocked(next);
    if (next) {
      // Re-lock: snap H to W.
      setSh(sw);
    }
  }
  const [cornerRadius, setCornerRadius] = useState(0);
  const [gx, setGx] = useState(5);
  const [gy, setGy] = useState(5);
  const [edgeMargin, setEdgeMargin] = useState(0);
  const [spacingMode, setSpacingMode] = useState<SpacingMode>("fixed");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);

  const layout = useMemo(
    () => fitLayout(aw, ah, sw, sh, gx, gy, edgeMargin, spacingMode),
    [aw, ah, sw, sh, gx, gy, edgeMargin, spacingMode]
  );

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    const req: GenerateRequest = {
      name: name || `Generated ${aw}x${ah}${units}`,
      artboard: { width: aw, height: ah, units },
      shape: {
        kind,
        width: sw,
        height: sh,
        gap_x: gx,
        gap_y: gy,
        center: true,
        edge_margin: edgeMargin,
        corner_radius: kind === "rect" ? cornerRadius : 0,
        spacing_mode: spacingMode,
      },
    };
    try {
      const tpl = await generateTemplate(req);
      navigate(`/app/templates/${tpl.id}`);
    } catch (e) {
      setErr(formatApiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-8 sm:gap-10 min-w-0"
    >
      <div className="space-y-6 min-w-0">
        <BackLink onBack={onBack} />
        <div>
          <label className="block text-sm font-medium text-neutral-300 mb-2">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. 55mm circles, A4"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 outline-none focus:border-neutral-600"
          />
        </div>

        <Section title="Artboard">
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Width" value={aw} onChange={setAw} />
            <NumberField label="Height" value={ah} onChange={setAh} />
            <Select
              label="Units"
              value={units}
              onChange={(v) => setUnits(v as "mm" | "in" | "pt")}
              options={[
                { v: "mm", l: "mm" },
                { v: "in", l: "in" },
                { v: "pt", l: "pt" },
              ]}
            />
          </div>
        </Section>

        <Section title="Shape">
          <div className="grid grid-cols-2 gap-3 mb-4">
            <ShapeTile
              active={shapeFamily === "oval"}
              onClick={() => pickFamily("oval")}
              label="Circle / Oval"
              hint="Lock for a perfect circle; unlock to set independent width & height."
            >
              <svg viewBox="0 0 40 40" width="44" height="44">
                {locked && shapeFamily === "oval" ? (
                  <circle cx="20" cy="20" r="14" fill="none" stroke="currentColor" strokeWidth="2" />
                ) : (
                  <ellipse cx="20" cy="20" rx="16" ry="10" fill="none" stroke="currentColor" strokeWidth="2" />
                )}
              </svg>
            </ShapeTile>
            <ShapeTile
              active={shapeFamily === "rect"}
              onClick={() => pickFamily("rect")}
              label="Square / Rectangle"
              hint="Equal W & H for a square. Add corner radius for rounded corners."
            >
              <svg viewBox="0 0 40 40" width="44" height="44">
                <rect
                  x="6"
                  y="6"
                  width="28"
                  height="28"
                  rx={cornerRadius > 0 ? Math.min(8, cornerRadius * 0.4) : 0}
                  ry={cornerRadius > 0 ? Math.min(8, cornerRadius * 0.4) : 0}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                />
              </svg>
            </ShapeTile>
          </div>

          {shapeFamily === "oval" && (
            <div className="space-y-3">
              {locked ? (
                <NumberField
                  label={`Diameter (${units})`}
                  value={sw}
                  onChange={(v) => { setSw(v); setSh(v); }}
                />
              ) : (
                <div className="grid grid-cols-2 gap-3">
                  <NumberField label={`Width (${units})`} value={sw} onChange={setSw} />
                  <NumberField label={`Height (${units})`} value={sh} onChange={setSh} />
                </div>
              )}
              <button
                type="button"
                onClick={toggleLock}
                className="flex items-center gap-2 text-xs text-neutral-400 hover:text-white transition"
              >
                <span className="text-base leading-none">{locked ? "🔒" : "🔓"}</span>
                {locked ? "Locked to circle — click to set custom width & height" : "Unlocked — click to lock as circle"}
              </button>
            </div>
          )}
          {kind === "rect" && (
            <div className="mt-3">
              <label className="block text-xs text-neutral-400 mb-1.5">
                Corner radius ({units}) ·{" "}
                <span className="text-neutral-500">
                  0 = sharp · max {(Math.min(sw, sh) / 2).toFixed(1)}
                </span>
              </label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={Math.min(sw, sh) / 2}
                  step={0.5}
                  value={Math.min(cornerRadius, Math.min(sw, sh) / 2)}
                  onChange={(e) => setCornerRadius(parseFloat(e.target.value))}
                  className="flex-1 accent-violet-500"
                />
                <input
                  type="number"
                  min={0}
                  max={Math.min(sw, sh) / 2}
                  step={0.5}
                  value={cornerRadius}
                  onChange={(e) =>
                    setCornerRadius(
                      Math.max(
                        0,
                        Math.min(parseFloat(e.target.value) || 0, Math.min(sw, sh) / 2)
                      )
                    )
                  }
                  className="w-20 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-base text-neutral-100 outline-none focus:border-neutral-600 font-mono"
                />
              </div>
              {cornerRadius >= Math.min(sw, sh) / 2 && cornerRadius > 0 && (
                <p className="text-[11px] text-violet-300 mt-1.5">
                  Tip: at max radius this is effectively a circle/oval.
                </p>
              )}
            </div>
          )}
        </Section>

        <Section title="Layout">
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label={`Edge margin (${units})`}
              value={edgeMargin}
              onChange={setEdgeMargin}
            />
            <Select
              label="Spacing"
              value={spacingMode}
              onChange={(v) => setSpacingMode(v as SpacingMode)}
              options={[
                { v: "fixed", l: "Fixed gap" },
                { v: "even", l: "Distribute evenly" },
              ]}
            />
          </div>
          <div className="grid grid-cols-2 gap-3 mt-3">
            <NumberField
              label={
                spacingMode === "fixed"
                  ? `Gap X (${units})`
                  : `Min gap X (${units})`
              }
              value={gx}
              onChange={setGx}
            />
            <NumberField
              label={
                spacingMode === "fixed"
                  ? `Gap Y (${units})`
                  : `Min gap Y (${units})`
              }
              value={gy}
              onChange={setGy}
            />
          </div>
          <p className="text-xs text-neutral-500 mt-3 leading-relaxed">
            {spacingMode === "fixed"
              ? `Slots are placed exactly ${gx}\u202F${units} apart horizontally and ${gy}\u202F${units} vertically. The grid is centred inside the safe zone; rows/columns that don't fit are dropped.`
              : `Slots pack flush against the safe-zone edges with leftover space distributed evenly between them. Spacing is never smaller than ${gx}\u202F${units} (X) or ${gy}\u202F${units} (Y) - increase these to drop a row/column when slots would otherwise sit too close.`}
            {edgeMargin > 0 && (
              <>
                {" "}No slot will appear within{" "}
                <span className="text-neutral-300">
                  {edgeMargin}&nbsp;{units}
                </span>{" "}
                of the artboard edge.
              </>
            )}
          </p>
        </Section>

        <QuotaErrorBanner error={err} />

        <button
          type="submit"
          disabled={busy || layout.cols < 1 || layout.rows < 1}
          className="rounded-lg bg-white px-6 py-3 font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
        >
          {busy
            ? "Generating…"
            : `Generate (${layout.cols}×${layout.rows} = ${layout.cols * layout.rows})`}
        </button>
      </div>

      <div className="lg:sticky lg:top-20 self-start min-w-0 max-w-full">
        <div className="text-sm text-neutral-400 mb-2">
          Preview: {layout.cols} × {layout.rows} = {layout.cols * layout.rows} slots
        </div>
        <GeneratorPreview
          artboardW={aw}
          artboardH={ah}
          shapeW={sw}
          shapeH={sh}
          edgeMargin={edgeMargin}
          kind={kind}
          cornerRadius={kind === "rect" ? cornerRadius : 0}
          layout={layout}
        />
      </div>
    </form>
  );
}

function ShapeTile({
  active,
  onClick,
  label,
  hint,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "text-left rounded-xl border p-4 transition flex gap-3 items-start " +
        (active
          ? "border-violet-500 bg-violet-500/10 text-white"
          : "border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600")
      }
    >
      <div className={active ? "text-violet-300" : "text-neutral-400"}>
        {children}
      </div>
      <div className="min-w-0">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-[11px] text-neutral-500 mt-0.5 leading-snug">
          {hint}
        </div>
      </div>
    </button>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
      <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
        {title}
      </legend>
      {children}
    </fieldset>
  );
}

function usePrevious<T>(value: T): T {
  const ref = useRef(value);
  const prev = ref.current;
  ref.current = value;
  return prev;
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const [raw, setRaw] = useState(String(value));
  const prev = usePrevious(value);
  if (prev !== value && String(value) !== raw) {
    setRaw(String(value));
  }

  return (
    <label className="block text-xs text-neutral-400">
      {label}
      <input
        type="number"
        min={0}
        step="0.1"
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={() => {
          const n = parseFloat(raw);
          if (Number.isNaN(n) || raw.trim() === "") {
            onChange(0);
            setRaw("0");
          } else {
            setRaw(String(n));
          }
        }}
        className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-base text-neutral-100 outline-none focus:border-neutral-600"
      />
    </label>
  );
}

function Select<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (v: T) => void;
  options: { v: T; l: string }[];
}) {
  return (
    <label className="block text-xs text-neutral-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-base text-neutral-100 outline-none focus:border-neutral-600"
      >
        {options.map((o) => (
          <option key={o.v} value={o.v}>
            {o.l}
          </option>
        ))}
      </select>
    </label>
  );
}

function BackLink({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="text-sm text-neutral-400 hover:text-white"
    >
      ← Back
    </button>
  );
}

type Layout = {
  cols: number;
  rows: number;
  /** Slot leading-edge positions in artboard units (origin top-left). */
  xs: number[];
  ys: number[];
};

/** Pure-JS port of `pdf_generator._layout_axis`. Keep in sync with the backend. */
function layoutAxis(
  available: number,
  size: number,
  gap: number,
  mode: SpacingMode
): { count: number; starts: number[] } {
  if (available <= 0 || size <= 0 || size > available) return { count: 0, starts: [] };
  if (mode === "even") {
    // `gap` here is a *minimum* spacing (see backend `_layout_axis`).
    const count = Math.max(1, Math.floor((available + gap) / (size + gap)));
    if (count === 1) return { count: 1, starts: [(available - size) / 2] };
    const leftover = available - count * size;
    const spacing = leftover / (count - 1);
    return {
      count,
      starts: Array.from({ length: count }, (_, i) => i * (size + spacing)),
    };
  }
  const count = Math.max(0, Math.floor((available + gap) / (size + gap)));
  if (count === 0) return { count: 0, starts: [] };
  const grid = count * size + Math.max(0, count - 1) * gap;
  const leading = (available - grid) / 2;
  return {
    count,
    starts: Array.from({ length: count }, (_, i) => leading + i * (size + gap)),
  };
}

function fitLayout(
  aw: number,
  ah: number,
  sw: number,
  sh: number,
  gx: number,
  gy: number,
  edgeMargin: number,
  mode: SpacingMode
): Layout {
  const availW = aw - 2 * edgeMargin;
  const availH = ah - 2 * edgeMargin;
  if (availW <= 0 || availH <= 0 || sw > availW || sh > availH) {
    return { cols: 0, rows: 0, xs: [], ys: [] };
  }
  const x = layoutAxis(availW, sw, gx, mode);
  const y = layoutAxis(availH, sh, gy, mode);
  return {
    cols: x.count,
    rows: y.count,
    xs: x.starts.map((s) => s + edgeMargin),
    ys: y.starts.map((s) => s + edgeMargin),
  };
}

function GeneratorPreview({
  artboardW,
  artboardH,
  shapeW,
  shapeH,
  edgeMargin,
  kind,
  cornerRadius,
  layout,
}: {
  artboardW: number;
  artboardH: number;
  shapeW: number;
  shapeH: number;
  edgeMargin: number;
  kind: "rect" | "circle" | "ellipse";
  cornerRadius: number;
  layout: Layout;
}) {
  // Render purely in artboard units and let the SVG viewBox handle scaling
  // to whatever width the container gives us. That keeps the preview
  // responsive on mobile (where the parent column may only be ~340px wide)
  // without ever forcing the page to scroll horizontally.

  const shapes: { x: number; y: number }[] = [];
  for (const y of layout.ys) {
    for (const x of layout.xs) {
      shapes.push({ x, y });
    }
  }

  const showSafeZone = edgeMargin > 0;
  // Stroke widths are in the same units as the artboard (e.g. mm). On a
  // 297mm-wide A4, 0.4mm reads as a fine hairline at the typical preview
  // size on both phone and desktop.
  const strokeUnits = Math.max(0.15, Math.min(artboardW, artboardH) / 600);

  return (
    <div
      className="rounded-xl border border-neutral-800 bg-white relative shadow-lg w-full max-w-full overflow-hidden"
      style={{ aspectRatio: `${artboardW} / ${artboardH}` }}
    >
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${artboardW} ${artboardH}`}
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0"
      >
        {showSafeZone && (
          <rect
            x={edgeMargin}
            y={edgeMargin}
            width={artboardW - 2 * edgeMargin}
            height={artboardH - 2 * edgeMargin}
            fill="none"
            stroke="#a78bfa"
            strokeWidth={strokeUnits * 1.5}
            strokeDasharray={`${strokeUnits * 5} ${strokeUnits * 5}`}
          />
        )}
        {shapes.map((s, i) => {
          if (kind === "circle") {
            return (
              <circle
                key={i}
                cx={s.x + shapeW / 2}
                cy={s.y + shapeH / 2}
                r={Math.min(shapeW, shapeH) / 2}
                fill="none"
                stroke="#0a0a0a"
                strokeWidth={strokeUnits}
              />
            );
          }
          if (kind === "ellipse") {
            return (
              <ellipse
                key={i}
                cx={s.x + shapeW / 2}
                cy={s.y + shapeH / 2}
                rx={shapeW / 2}
                ry={shapeH / 2}
                fill="none"
                stroke="#0a0a0a"
                strokeWidth={strokeUnits}
              />
            );
          }
          return (
            <rect
              key={i}
              x={s.x}
              y={s.y}
              width={shapeW}
              height={shapeH}
              rx={Math.min(cornerRadius, Math.min(shapeW, shapeH) / 2)}
              ry={Math.min(cornerRadius, Math.min(shapeW, shapeH) / 2)}
              fill="none"
              stroke="#0a0a0a"
              strokeWidth={strokeUnits}
            />
          );
        })}
      </svg>
      {showSafeZone && (
        <div className="absolute bottom-2 right-2 text-[10px] uppercase tracking-widest text-violet-500/80 bg-white/70 px-2 py-0.5 rounded">
          safe&nbsp;zone
        </div>
      )}
    </div>
  );
}
