import { useMemo, useState } from "react";
import ToolShell, { Field, inputClass } from "./ToolShell";
import { getTool } from "../../content/tools";

/**
 * Three small, evergreen print-prep utilities in one page: mm/inch converter,
 * bleed calculator and a DPI checker. Pure client-side maths, SSR-safe.
 */
export default function BleedDpiCalculator() {
  const tool = getTool("bleed-dpi-calculator")!;
  return (
    <ToolShell
      tool={tool}
      intro="Three quick checks before you send a file to print: convert between millimetres and inches, add bleed to any size, and confirm an image has enough resolution (DPI) to print sharp."
      faq={FAQ}
      about={ABOUT}
    >
      <div className="space-y-5">
        <UnitConverter />
        <BleedCalc />
        <DpiCheck />
      </div>
    </ToolShell>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function num(v: string): number {
  return parseFloat(v) || 0;
}

function UnitConverter() {
  const [mm, setMm] = useState(210);
  const inches = mm / 25.4;
  return (
    <Panel title="mm ↔ inch converter">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Millimetres (mm)">
          <input
            type="number"
            value={mm}
            min={0}
            onChange={(e) => setMm(num(e.target.value))}
            className={inputClass}
          />
        </Field>
        <Field label="Inches (in)">
          <input
            type="number"
            value={Number(inches.toFixed(3))}
            min={0}
            onChange={(e) => setMm(num(e.target.value) * 25.4)}
            className={inputClass}
          />
        </Field>
      </div>
      <p className="mt-3 text-sm text-neutral-500">
        {mm} mm = <span className="text-neutral-200">{inches.toFixed(3)} in</span>{" "}
        · 1 in = 25.4 mm
      </p>
    </Panel>
  );
}

function BleedCalc() {
  const [unit, setUnit] = useState<"mm" | "in">("mm");
  const [w, setW] = useState(210);
  const [h, setH] = useState(297);
  const [bleed, setBleed] = useState(3);
  const finalW = w + bleed * 2;
  const finalH = h + bleed * 2;
  return (
    <Panel title="Bleed calculator">
      <div className="mb-4 inline-flex rounded-full border border-neutral-800 bg-neutral-900/60 p-1">
        {(["mm", "in"] as const).map((opt) => (
          <button
            key={opt}
            onClick={() => {
              if (opt === unit) return;
              const f = opt === "in" ? 1 / 25.4 : 25.4;
              setW(Number((w * f).toFixed(3)));
              setH(Number((h * f).toFixed(3)));
              setBleed(Number((bleed * f).toFixed(3)));
              setUnit(opt);
            }}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              unit === opt ? "bg-white text-neutral-950" : "text-neutral-400 hover:text-white"
            }`}
          >
            {opt}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label={`Width (${unit})`}>
          <input type="number" value={w} min={0} onChange={(e) => setW(num(e.target.value))} className={inputClass} />
        </Field>
        <Field label={`Height (${unit})`}>
          <input type="number" value={h} min={0} onChange={(e) => setH(num(e.target.value))} className={inputClass} />
        </Field>
        <Field label={`Bleed each edge (${unit})`}>
          <input type="number" value={bleed} min={0} step={0.5} onChange={(e) => setBleed(num(e.target.value))} className={inputClass} />
        </Field>
      </div>
      <p className="mt-4 text-sm text-neutral-300">
        Final canvas with bleed:{" "}
        <span className="font-semibold text-white">
          {finalW.toFixed(2)} × {finalH.toFixed(2)} {unit}
        </span>
      </p>
    </Panel>
  );
}

function DpiCheck() {
  const [unit, setUnit] = useState<"in" | "cm">("in");
  const [px, setPx] = useState(3000);
  const [pyx, setPyx] = useState(3000);
  const [printW, setPrintW] = useState(10);
  const [printH, setPrintH] = useState(10);

  const { dpiW, dpiH, verdict, tone } = useMemo(() => {
    const wIn = unit === "in" ? printW : printW / 2.54;
    const hIn = unit === "in" ? printH : printH / 2.54;
    const dW = wIn > 0 ? px / wIn : 0;
    const dH = hIn > 0 ? pyx / hIn : 0;
    const min = Math.min(dW, dH);
    let v = "Enter your numbers above";
    let t: "neutral" | "good" | "ok" | "bad" = "neutral";
    if (min > 0) {
      if (min >= 300) {
        v = "Excellent — sharp at full size";
        t = "good";
      } else if (min >= 150) {
        v = "Usable — fine for larger prints viewed at a distance";
        t = "ok";
      } else {
        v = "Too low — will look soft or pixelated";
        t = "bad";
      }
    }
    return { dpiW: dW, dpiH: dH, verdict: v, tone: t };
  }, [unit, px, pyx, printW, printH]);

  const toneClass =
    tone === "good"
      ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
      : tone === "ok"
      ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
      : tone === "bad"
      ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
      : "border-neutral-800 bg-neutral-950/40 text-neutral-400";

  return (
    <Panel title="DPI / resolution checker">
      <div className="mb-4 inline-flex rounded-full border border-neutral-800 bg-neutral-900/60 p-1">
        {(["in", "cm"] as const).map((opt) => (
          <button
            key={opt}
            onClick={() => setUnit(opt)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
              unit === opt ? "bg-white text-neutral-950" : "text-neutral-400 hover:text-white"
            }`}
          >
            {opt === "in" ? "Inches" : "cm"}
          </button>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Image width (pixels)">
          <input type="number" value={px} min={0} onChange={(e) => setPx(num(e.target.value))} className={inputClass} />
        </Field>
        <Field label="Image height (pixels)">
          <input type="number" value={pyx} min={0} onChange={(e) => setPyx(num(e.target.value))} className={inputClass} />
        </Field>
        <Field label={`Print width (${unit})`}>
          <input type="number" value={printW} min={0} onChange={(e) => setPrintW(num(e.target.value))} className={inputClass} />
        </Field>
        <Field label={`Print height (${unit})`}>
          <input type="number" value={printH} min={0} onChange={(e) => setPrintH(num(e.target.value))} className={inputClass} />
        </Field>
      </div>
      <div className={`mt-4 rounded-xl border p-4 ${toneClass}`}>
        <div className="text-sm">
          Effective resolution:{" "}
          <span className="font-semibold">
            {dpiW ? `${dpiW.toFixed(0)} × ${dpiH.toFixed(0)} DPI` : "—"}
          </span>
        </div>
        <div className="mt-1 text-sm font-medium">{verdict}</div>
      </div>
    </Panel>
  );
}

const FAQ = [
  {
    q: "What DPI should I print at?",
    a: "300 DPI at final print size is the standard for crisp results. For large prints viewed from a distance — banners, big stickers — 150 DPI is often acceptable. Below about 150 DPI artwork starts to look soft or pixelated.",
  },
  {
    q: "How much bleed do I need?",
    a: "3 mm (about 0.125 inch) is the most common bleed for stickers and small print. Extend your background past every edge by that amount so trimming or cutting never leaves a white sliver.",
  },
  {
    q: "How do I convert mm to inches?",
    a: "Divide millimetres by 25.4 to get inches, or multiply inches by 25.4 to get millimetres. For example, 210 mm ÷ 25.4 = 8.27 inches.",
  },
];

const ABOUT = (
  <>
    <h2>Getting files print-ready</h2>
    <p>
      Most reprints come down to three things: wrong size, missing bleed, or low
      resolution. A quick check on each before you commit a sheet to the printer
      saves film, ink and time. Set your canvas to the final size plus bleed,
      keep artwork at 300 DPI at that size, and make sure cut lines sit on the
      trim — not the bleed.
    </p>
    <p>
      Printlay handles bleed and cut lines for you when you build a sheet, and
      flags artwork that's too low-resolution before it reaches the printer.
    </p>
  </>
);
