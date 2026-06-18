import { useMemo, useState } from "react";
import ToolShell, { Field, inputClass } from "./ToolShell";
import { getTool } from "../../content/tools";

/**
 * Gang sheet calculator. Pure client-side maths (SSR-safe — no window access
 * during render). All measurements are in millimetres. Computes best-fit
 * packing across both orientations, sheets needed for a quantity, material
 * utilisation, and cost — priced per linear metre of film (DTF is roll-fed at
 * a fixed width and sold by length), so the full-sheet cost comes from the
 * sheet length.
 */
export default function GangSheetCalculator() {
  const tool = getTool("gang-sheet-calculator")!;

  // All dimensions in millimetres. Defaults: a 560 mm (≈22") DTF roll width,
  // a 1000 mm (1 m) sheet length, a 75 mm design, 3 mm gap.
  const [sheetW, setSheetW] = useState(560);
  const [sheetL, setSheetL] = useState(1000);
  const [designW, setDesignW] = useState(75);
  const [designH, setDesignH] = useState(75);
  const [gap, setGap] = useState(3);
  const [qty, setQty] = useState(100);
  const [pricePerMetre, setPricePerMetre] = useState(0);

  const r = useMemo(() => {
    const fits = (sw: number, sl: number, dw: number, dh: number) => {
      if (dw <= 0 || dh <= 0) return 0;
      const cols = Math.floor((sw + gap) / (dw + gap));
      const rows = Math.floor((sl + gap) / (dh + gap));
      return Math.max(0, cols) * Math.max(0, rows);
    };
    const upright = fits(sheetW, sheetL, designW, designH);
    const rotated = fits(sheetW, sheetL, designH, designW);
    const perSheet = Math.max(upright, rotated);
    const rotatedWins = rotated > upright;
    const sheetsNeeded = perSheet > 0 ? Math.ceil(qty / perSheet) : 0;
    const sheetArea = sheetW * sheetL;
    const designArea = designW * designH;
    const utilisation =
      sheetArea > 0 ? Math.min(100, (perSheet * designArea * 100) / sheetArea) : 0;
    // Film is priced per linear metre at the sheet width, so the cost of one
    // sheet is the price per metre × the sheet length in metres.
    const sheetLengthM = sheetL / 1000;
    const sheetCost = pricePerMetre > 0 ? pricePerMetre * sheetLengthM : null;
    const costPerPrint =
      sheetCost != null && perSheet > 0 ? sheetCost / perSheet : null;
    const totalCost =
      sheetCost != null && sheetsNeeded > 0 ? sheetCost * sheetsNeeded : null;
    return {
      perSheet,
      rotatedWins,
      sheetsNeeded,
      utilisation,
      waste: 100 - utilisation,
      sheetLengthM,
      sheetCost,
      costPerPrint,
      totalCost,
    };
  }, [sheetW, sheetL, designW, designH, gap, qty, pricePerMetre]);

  return (
    <ToolShell
      tool={tool}
      intro="Enter your sheet and design sizes in millimetres to see how many prints fit per gang sheet, how many sheets an order needs, your material utilisation and the cost per print. Film is priced per linear metre, so set your price per metre and the full sheet cost is worked out from the sheet length. Works for DTF, UV DTF and die-cut stickers."
      faq={FAQ}
      about={ABOUT}
    >
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Sheet width (mm)" hint="roll / printable width">
            <NumberInput value={sheetW} onChange={setSheetW} step={10} />
          </Field>
          <Field label="Sheet length (mm)" hint="the roll-fed length">
            <NumberInput value={sheetL} onChange={setSheetL} step={10} />
          </Field>
          <Field label="Design width (mm)">
            <NumberInput value={designW} onChange={setDesignW} step={5} />
          </Field>
          <Field label="Design height (mm)">
            <NumberInput value={designH} onChange={setDesignH} step={5} />
          </Field>
          <Field label="Gap between designs (mm)" hint="spacing / weeding margin">
            <NumberInput value={gap} onChange={setGap} step={1} />
          </Field>
          <Field label="Quantity needed">
            <NumberInput value={qty} onChange={setQty} step={1} />
          </Field>
          <Field
            label="Price per metre (optional)"
            hint="film cost per linear metre at this width"
          >
            <NumberInput value={pricePerMetre} onChange={setPricePerMetre} step={0.5} />
          </Field>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          <Stat label="Designs per sheet" value={r.perSheet || "—"} accent />
          <Stat label="Sheets needed" value={r.sheetsNeeded || "—"} />
          <Stat
            label="Material used"
            value={r.perSheet ? `${r.utilisation.toFixed(0)}%` : "—"}
          />
          <Stat
            label="Wasted film"
            value={r.perSheet ? `${r.waste.toFixed(0)}%` : "—"}
          />
          <Stat
            label="Cost per sheet"
            value={r.sheetCost != null ? r.sheetCost.toFixed(2) : "—"}
          />
          <Stat
            label="Cost per print"
            value={r.costPerPrint != null ? r.costPerPrint.toFixed(2) : "—"}
          />
          <Stat
            label="Total media cost"
            value={r.totalCost != null ? r.totalCost.toFixed(2) : "—"}
          />
        </div>

        {r.sheetCost != null && r.perSheet > 0 && (
          <p className="mt-4 text-xs text-neutral-500">
            Sheet cost = price per metre × {r.sheetLengthM.toFixed(2)} m sheet
            length. Cost per print divides that across {r.perSheet} designs and
            ignores the part-used final sheet.
          </p>
        )}
        {r.perSheet > 0 && r.sheetCost == null && (
          <p className="mt-4 text-xs text-neutral-500">
            Best fit packs {r.perSheet} per sheet
            {r.rotatedWins ? " (designs rotated 90°)" : ""}. Add a price per metre
            to see the cost per print.
          </p>
        )}
        {r.perSheet === 0 && (
          <p className="mt-4 text-xs text-amber-300/80">
            That design doesn't fit the sheet at the current size and gap — check
            your dimensions.
          </p>
        )}
      </div>
    </ToolShell>
  );
}

function NumberInput({
  value,
  onChange,
  step = 1,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      min={0}
      step={step}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
      className={inputClass}
    />
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border p-4 ${
        accent
          ? "border-violet-500/40 bg-violet-500/10"
          : "border-neutral-800 bg-neutral-950/40"
      }`}
    >
      <div className="text-xs text-neutral-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tracking-tight text-white">
        {value}
      </div>
    </div>
  );
}

const FAQ = [
  {
    q: "What size is a standard DTF gang sheet?",
    a: "DTF gang sheets are sold by width and length. The most common width is about 560 mm (22 inches) to match popular DTF printers and roll widths, with the length varying from around 300 mm up to several metres. UV DTF sheets are often smaller, commonly 300 x 300 mm or A3.",
  },
  {
    q: "How much gap should I leave between designs?",
    a: "For DTF, 3–5 mm is typical so transfers can be cut apart cleanly. For die-cut stickers leave enough margin for the cutter and for weeding. The calculator includes the gap on every side when working out the fit.",
  },
  {
    q: "How is the cost per print calculated?",
    a: "DTF film is priced per linear metre at a fixed roll width, so the cost of one sheet is your price per metre × the sheet length in metres. Cost per print is that sheet cost divided by the number of designs that fit on the sheet. It's a media estimate — it doesn't include ink, labour, weeding, application tape or your margin.",
  },
  {
    q: "Why is the price set per metre rather than per sheet?",
    a: "Because roll-fed DTF has a fixed width and you buy it by length. Setting a price per metre lets the calculator work out the cost of any sheet length automatically — a 1 metre sheet and a 2 metre sheet are costed correctly from the same per-metre price.",
  },
  {
    q: "Does it rotate designs to fit more on?",
    a: "Yes. The calculator tests both orientations (upright and rotated 90°) and uses whichever packs more designs onto the sheet.",
  },
];

const ABOUT = (
  <>
    <h2>How the gang sheet calculator works</h2>
    <p>
      Ganging up means tiling many designs onto one large sheet so you print and
      cut them together — the single biggest way to cut your cost per print and
      reduce film waste. This calculator works out the best fit by dividing the
      usable sheet area by your design size plus the gap, testing both
      orientations, and reporting how many sheets an order needs.
    </p>
    <h3>Tips to fit more on a sheet</h3>
    <ul>
      <li>Tighten the gap to the minimum your cutter and weeding allow.</li>
      <li>Rotate tall designs to run along the sheet width.</li>
      <li>Mix design sizes to fill the gaps — true nesting beats a fixed grid.</li>
      <li>Round up artwork to consistent sizes so they tile predictably.</li>
    </ul>
    <p>
      Printlay does this automatically: drop your designs in and it nests them
      onto print-ready gang sheets with cut lines, so you never eyeball spacing
      in Illustrator again.
    </p>
  </>
);
