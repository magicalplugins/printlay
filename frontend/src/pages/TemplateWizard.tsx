import { FormEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  GenerateRequest,
  SpacingMode,
  generateTemplate,
  uploadTemplate,
} from "../api/templates";

type Path = "choose" | "upload" | "generate";

export default function TemplateWizard() {
  const [path, setPath] = useState<Path>("choose");

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight">New template</h1>
        <p className="text-neutral-400 mt-1">
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
        body="Specify the artboard, the shape (rectangle or circle), and the gap. We auto-fit and centre the grid for you."
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
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const tpl = await uploadTemplate(file, name || file.name);
      navigate(`/app/templates/${tpl.id}`);
    } catch (e) {
      setErr(String(e));
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
          Tip: in Illustrator, put your slot rectangles/circles on a layer named{" "}
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
      {err && <div className="text-sm text-rose-400">{err}</div>}
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
  const [kind, setKind] = useState<"rect" | "circle">("circle");
  const [sw, setSw] = useState(55);
  const [sh, setSh] = useState(55);
  const [gx, setGx] = useState(5);
  const [gy, setGy] = useState(5);
  const [edgeMargin, setEdgeMargin] = useState(0);
  const [spacingMode, setSpacingMode] = useState<SpacingMode>("fixed");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
        spacing_mode: spacingMode,
      },
    };
    try {
      const tpl = await generateTemplate(req);
      navigate(`/app/templates/${tpl.id}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="grid lg:grid-cols-2 gap-10">
      <div className="space-y-6">
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
          <div className="grid grid-cols-3 gap-3">
            <Select
              label="Type"
              value={kind}
              onChange={(v) => setKind(v as "rect" | "circle")}
              options={[
                { v: "rect", l: "Rectangle" },
                { v: "circle", l: "Circle" },
              ]}
            />
            <NumberField label="Width" value={sw} onChange={setSw} />
            <NumberField label="Height" value={sh} onChange={setSh} />
          </div>
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
          {spacingMode === "fixed" && (
            <div className="grid grid-cols-2 gap-3 mt-3">
              <NumberField label={`Gap X (${units})`} value={gx} onChange={setGx} />
              <NumberField label={`Gap Y (${units})`} value={gy} onChange={setGy} />
            </div>
          )}
          <p className="text-xs text-neutral-500 mt-3 leading-relaxed">
            {spacingMode === "fixed"
              ? `Slots are placed exactly ${gx}\u202F${units} apart horizontally and ${gy}\u202F${units} vertically. The grid is centred inside the safe zone; rows/columns that don't fit are dropped.`
              : "Slots are packed flush against the safe-zone edges with leftover space distributed evenly between them. Slot size never changes."}
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

        {err && <div className="text-sm text-rose-400">{err}</div>}

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

      <div className="lg:sticky lg:top-20 self-start">
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
          layout={layout}
        />
      </div>
    </form>
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

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="block text-xs text-neutral-400">
      {label}
      <input
        type="number"
        min={0}
        step="0.1"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
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
    const count = Math.max(1, Math.floor(available / size));
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
  layout,
}: {
  artboardW: number;
  artboardH: number;
  shapeW: number;
  shapeH: number;
  edgeMargin: number;
  kind: "rect" | "circle";
  layout: Layout;
}) {
  const PREVIEW_W = 480;
  const aspect = artboardH / artboardW;
  const previewH = PREVIEW_W * aspect;
  const scale = PREVIEW_W / artboardW;

  const shapes: { x: number; y: number }[] = [];
  for (const y of layout.ys) {
    for (const x of layout.xs) {
      shapes.push({ x, y });
    }
  }

  const showSafeZone = edgeMargin > 0;

  return (
    <div
      className="rounded-xl border border-neutral-800 bg-white relative shadow-lg"
      style={{ width: PREVIEW_W, height: previewH }}
    >
      <svg
        width={PREVIEW_W}
        height={previewH}
        viewBox={`0 0 ${PREVIEW_W} ${previewH}`}
        className="absolute inset-0"
      >
        {showSafeZone && (
          <rect
            x={edgeMargin * scale}
            y={edgeMargin * scale}
            width={(artboardW - 2 * edgeMargin) * scale}
            height={(artboardH - 2 * edgeMargin) * scale}
            fill="none"
            stroke="#a78bfa"
            strokeWidth="0.8"
            strokeDasharray="3 3"
          />
        )}
        {shapes.map((s, i) =>
          kind === "circle" ? (
            <circle
              key={i}
              cx={(s.x + shapeW / 2) * scale}
              cy={(s.y + shapeH / 2) * scale}
              r={(Math.min(shapeW, shapeH) / 2) * scale}
              fill="none"
              stroke="#0a0a0a"
              strokeWidth="0.6"
            />
          ) : (
            <rect
              key={i}
              x={s.x * scale}
              y={s.y * scale}
              width={shapeW * scale}
              height={shapeH * scale}
              fill="none"
              stroke="#0a0a0a"
              strokeWidth="0.6"
            />
          )
        )}
      </svg>
      {showSafeZone && (
        <div className="absolute bottom-2 right-2 text-[10px] uppercase tracking-widest text-violet-500/80 bg-white/70 px-2 py-0.5 rounded">
          safe&nbsp;zone
        </div>
      )}
    </div>
  );
}
