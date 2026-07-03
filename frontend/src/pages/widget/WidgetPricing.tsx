import { useEffect, useState } from "react";
import WidgetShell, {
  btnDanger,
  btnPrimary,
  btnSecondary,
  card,
  emptyCls,
  inputCls,
  labelCls,
} from "./WidgetShell";
import {
  PricingProfile,
  PricingProfileInput,
  QuantityBreak,
  createPricingProfile,
  deletePricingProfile,
  listPricingProfiles,
  updatePricingProfile,
} from "../../api/widget";
import { apiErrMessage } from "../../api/client";

const CURRENCIES = [
  { code: "GBP", name: "British Pound" },
  { code: "USD", name: "US Dollar" },
  { code: "EUR", name: "Euro" },
  { code: "AUD", name: "Australian Dollar" },
  { code: "CAD", name: "Canadian Dollar" },
  { code: "NZD", name: "New Zealand Dollar" },
  { code: "CHF", name: "Swiss Franc" },
  { code: "SEK", name: "Swedish Krona" },
  { code: "NOK", name: "Norwegian Krone" },
  { code: "DKK", name: "Danish Krone" },
];

const BLANK: PricingProfileInput = {
  name: "New pricing",
  currency: "GBP",
  sheet_width_mm: 560,
  price_per_metre: 6,
  gap_mm: 3,
  margin_pct: 200,
  handling_fee: 0,
  min_order_price: 5,
  min_length_m: 0,
  vinyl_surcharges: null,
  finish_surcharges: null,
  quantity_breaks: [],
  quantity_presets: [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500],
  allow_custom_quantity: true,
  extras_required: false,
};

type SurchargeRow = { key: string; value: number };

export default function WidgetPricing() {
  const [profiles, setProfiles] = useState<PricingProfile[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; data: PricingProfileInput } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => listPricingProfiles().then(setProfiles).catch((e) => setErr(apiErrMessage(e)));
  useEffect(() => {
    load();
  }, []);

  const startNew = () => setEditing({ id: null, data: { ...BLANK } });
  const startEdit = (p: PricingProfile) =>
    setEditing({
      id: p.id,
      data: {
        name: p.name,
        currency: p.currency,
        sheet_width_mm: p.sheet_width_mm,
        price_per_metre: p.price_per_metre,
        gap_mm: p.gap_mm,
        margin_pct: p.margin_pct,
        handling_fee: p.handling_fee,
        min_order_price: p.min_order_price,
        min_length_m: p.min_length_m ?? 0,
        vinyl_surcharges: p.vinyl_surcharges,
        finish_surcharges: p.finish_surcharges,
        quantity_breaks: p.quantity_breaks,
        quantity_presets: p.quantity_presets ?? [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500],
        allow_custom_quantity: p.allow_custom_quantity ?? true,
        extras_required: p.extras_required ?? false,
      },
    });

  const duplicate = (p: PricingProfile) => {
    setEditing({
      id: null,
      data: {
        name: `${p.name} (copy)`,
        currency: p.currency,
        sheet_width_mm: p.sheet_width_mm,
        price_per_metre: p.price_per_metre,
        gap_mm: p.gap_mm,
        margin_pct: p.margin_pct,
        handling_fee: p.handling_fee,
        min_order_price: p.min_order_price,
        min_length_m: p.min_length_m ?? 0,
        vinyl_surcharges: p.vinyl_surcharges,
        finish_surcharges: p.finish_surcharges,
        quantity_breaks: p.quantity_breaks,
        quantity_presets: p.quantity_presets ?? [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500],
        allow_custom_quantity: p.allow_custom_quantity ?? true,
        extras_required: p.extras_required ?? false,
      },
    });
  };

  const remove = async (p: PricingProfile) => {
    if (!confirm(`Delete "${p.name}"? Products using it will fall back to no pricing.`)) return;
    try {
      await deletePricingProfile(p.id);
      load();
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  if (editing) {
    return (
      <ProfileEditor
        initial={editing.data}
        isNew={editing.id === null}
        onCancel={() => setEditing(null)}
        onSave={async (data) => {
          setErr(null);
          try {
            if (editing.id) await updatePricingProfile(editing.id, data);
            else await createPricingProfile(data);
            setEditing(null);
            load();
          } catch (e) {
            setErr(apiErrMessage(e));
            throw e;
          }
        }}
      />
    );
  }

  return (
    <WidgetShell
      title="Pricing profiles"
      subtitle="Reusable price rules. Products reference a profile to price designs automatically."
      actions={
        <button className={btnPrimary} onClick={startNew}>
          New profile
        </button>
      }
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}
      {profiles === null ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : profiles.length === 0 ? (
        <div className={emptyCls}>No pricing profiles yet. Create one to price your stickers.</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {profiles.map((p) => (
            <div key={p.id} className={card}>
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h3 className="font-semibold">{p.name}</h3>
                  <p className="text-sm text-neutral-400 mt-1">
                    {p.currency} {p.price_per_metre}/m · {p.sheet_width_mm}mm wide · {p.margin_pct}% margin
                  </p>
                  {p.quantity_breaks && p.quantity_breaks.length > 0 && (
                    <p className="text-xs text-neutral-500 mt-1">
                      {p.quantity_breaks.length} volume tier
                      {p.quantity_breaks.length > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button className={btnSecondary} onClick={() => startEdit(p)}>
                  Edit
                </button>
                <button className={btnSecondary} onClick={() => duplicate(p)}>
                  Duplicate
                </button>
                <button className={btnDanger} onClick={() => remove(p)}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </WidgetShell>
  );
}

function mapToRows(m: Record<string, number> | null): SurchargeRow[] {
  if (!m) return [];
  return Object.entries(m).map(([key, value]) => ({ key, value }));
}
function rowsToMap(rows: SurchargeRow[]): Record<string, number> | null {
  const clean = rows.filter((r) => r.key.trim());
  if (clean.length === 0) return null;
  return Object.fromEntries(clean.map((r) => [r.key.trim(), r.value || 0]));
}

function ProfileEditor({
  initial,
  isNew,
  onCancel,
  onSave,
}: {
  initial: PricingProfileInput;
  isNew: boolean;
  onCancel: () => void;
  onSave: (d: PricingProfileInput) => Promise<void>;
}) {
  const [d, setD] = useState(initial);
  const [vinylRows, setVinylRows] = useState<SurchargeRow[]>(mapToRows(initial.vinyl_surcharges));
  const [finishRows, setFinishRows] = useState<SurchargeRow[]>(mapToRows(initial.finish_surcharges));
  const [breaks, setBreaks] = useState<QuantityBreak[]>(initial.quantity_breaks || []);
  const [qtyPresets, setQtyPresets] = useState<number[]>(initial.quantity_presets ?? [10, 30, 50, 100, 200, 300, 500, 750, 1000, 2500]);
  const [allowCustomQty, setAllowCustomQty] = useState(initial.allow_custom_quantity ?? true);
  const [newQty, setNewQty] = useState("");
  const [saving, setSaving] = useState(false);

  const num = (k: keyof PricingProfileInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setD({ ...d, [k]: parseFloat(e.target.value) || 0 });

  const save = async () => {
    setSaving(true);
    try {
      await onSave({
        ...d,
        vinyl_surcharges: rowsToMap(vinylRows),
        finish_surcharges: rowsToMap(finishRows),
        quantity_breaks: breaks.filter((b) => b.min_qty > 0),
        quantity_presets: qtyPresets.sort((a, b) => a - b),
        allow_custom_quantity: allowCustomQty,
      });
    } catch {
      /* error surfaced by parent */
    } finally {
      setSaving(false);
    }
  };

  return (
    <WidgetShell
      title={isNew ? "New pricing profile" : "Edit pricing profile"}
      actions={
        <>
          <button className={btnSecondary} onClick={onCancel}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save profile"}
          </button>
        </>
      }
    >
      <div className={`${card} space-y-5`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <input className={inputCls} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Currency">
            <select
              className={inputCls}
              value={d.currency}
              onChange={(e) => setD({ ...d, currency: e.target.value })}
            >
              {CURRENCIES.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Media / roll width (mm)" hint="usable print width">
            <input type="number" className={inputCls} value={d.sheet_width_mm} onChange={num("sheet_width_mm")} />
          </Field>
          <Field label="Price per metre" hint="base media cost per linear metre">
            <input type="number" className={inputCls} value={d.price_per_metre} onChange={num("price_per_metre")} />
          </Field>
          <Field label="Gap between stickers (mm)">
            <input type="number" className={inputCls} value={d.gap_mm} onChange={num("gap_mm")} />
          </Field>
          <Field label="Margin %" hint="markup on media cost, e.g. 200 = 3×">
            <input type="number" className={inputCls} value={d.margin_pct} onChange={num("margin_pct")} />
          </Field>
          <Field label="Handling fee" hint="flat per-order fee">
            <input type="number" className={inputCls} value={d.handling_fee} onChange={num("handling_fee")} />
          </Field>
          <Field label="Minimum order price">
            <input type="number" className={inputCls} value={d.min_order_price} onChange={num("min_order_price")} />
          </Field>
          <Field label="Minimum billable length (m)" hint="0 = charge exact usage. 1 = DTF sheets (min 1m)">
            <select
              className={inputCls}
              value={d.min_length_m}
              onChange={(e) => setD({ ...d, min_length_m: parseFloat(e.target.value) })}
            >
              <option value={0}>Pro-rata (charge actual usage)</option>
              <option value={1}>1 metre minimum (DTF sheets)</option>
              <option value={0.5}>0.5 metre minimum</option>
              <option value={2}>2 metre minimum</option>
            </select>
          </Field>
        </div>
      </div>

      <SurchargeEditor
        title="Material surcharges"
        hint="Named materials with a fixed surcharge per metre added to the base price. E.g. Holographic +2/m."
        rows={vinylRows}
        setRows={setVinylRows}
        currency={d.currency}
      />
      <SurchargeEditor
        title="Finish surcharges"
        hint="Named extras with a fixed surcharge per metre. E.g. Speedy Turn-Around +5/m."
        rows={finishRows}
        setRows={setFinishRows}
        currency={d.currency}
      />
      <div className="px-4 pb-3 -mt-3">
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={d.extras_required ?? false}
            onChange={(e) => setD({ ...d, extras_required: e.target.checked })}
          />
          <span>Extras required (customer must select at least one)</span>
        </label>
      </div>

      <div className={`${card} mt-6`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm">Volume discounts</h3>
            <p className="text-xs text-neutral-500 mt-0.5">Per-metre tiers. Highest matching tier applies.</p>
          </div>
          <button
            className={btnSecondary}
            onClick={() => setBreaks([...breaks, { min_qty: 0, discount_pct: 0 }])}
          >
            Add tier
          </button>
        </div>
        {breaks.length === 0 ? (
          <p className="text-sm text-neutral-500">No volume discounts.</p>
        ) : (
          <div className="space-y-2">
            {breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-neutral-500 shrink-0">From</span>
                <input
                  type="number"
                  className={`${inputCls} w-20`}
                  value={b.min_qty}
                  onChange={(e) =>
                    setBreaks(breaks.map((x, j) => (j === i ? { ...x, min_qty: parseInt(e.target.value) || 0 } : x)))
                  }
                />
                <span className="text-xs text-neutral-500 shrink-0">metres →</span>
                <input
                  type="number"
                  className={`${inputCls} w-20`}
                  value={b.discount_pct}
                  onChange={(e) =>
                    setBreaks(breaks.map((x, j) => (j === i ? { ...x, discount_pct: parseFloat(e.target.value) || 0 } : x)))
                  }
                />
                <span className="text-xs text-neutral-500 shrink-0">% off</span>
                <button
                  className="ml-auto text-rose-300 text-sm hover:text-rose-200"
                  onClick={() => setBreaks(breaks.filter((_, j) => j !== i))}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Quantity options */}
      <div className={`${card} mt-6`}>
        <div className="mb-3">
          <h3 className="font-semibold text-sm">Quantity options</h3>
          <p className="text-xs text-neutral-500 mt-0.5">
            Preset quantities shown as radio buttons to the customer. They pick one or enter a custom amount.
          </p>
        </div>
        {qtyPresets.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3">
            {qtyPresets.sort((a, b) => a - b).map((q, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/40 pl-3 pr-1.5 py-1 text-sm"
              >
                {q.toLocaleString()}
                <button
                  type="button"
                  className="text-neutral-500 hover:text-rose-300 px-1"
                  onClick={() => setQtyPresets(qtyPresets.filter((_, j) => j !== i))}
                  aria-label="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            type="number"
            className={`${inputCls} w-28`}
            placeholder="e.g. 500"
            value={newQty}
            onChange={(e) => setNewQty(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = parseInt(newQty);
                if (v > 0 && !qtyPresets.includes(v)) { setQtyPresets([...qtyPresets, v]); setNewQty(""); }
              }
            }}
          />
          <button
            className={btnSecondary}
            onClick={() => {
              const v = parseInt(newQty);
              if (v > 0 && !qtyPresets.includes(v)) { setQtyPresets([...qtyPresets, v]); setNewQty(""); }
            }}
          >
            Add
          </button>
        </div>
        <label className="flex items-center gap-2 text-sm text-neutral-300 mt-3">
          <input
            type="checkbox"
            checked={allowCustomQty}
            onChange={(e) => setAllowCustomQty(e.target.checked)}
            className="accent-violet-500"
          />
          Allow custom quantity (customer can type their own)
        </label>
      </div>
    </WidgetShell>
  );
}

function SurchargeEditor({
  title,
  hint,
  rows,
  setRows,
  currency,
}: {
  title: string;
  hint: string;
  rows: SurchargeRow[];
  setRows: (r: SurchargeRow[]) => void;
  currency: string;
}) {
  return (
    <div className={`${card} mt-6`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-xs text-neutral-500 mt-0.5 max-w-md">{hint}</p>
        </div>
        <button className={btnSecondary} onClick={() => setRows([...rows, { key: "", value: 0 }])}>
          Add
        </button>
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-neutral-500">None.</p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <input
                className="min-w-0 flex-[3] rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none"
                placeholder="Name (e.g. Gloss)"
                value={r.key}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <span className="text-xs text-neutral-500 shrink-0">+</span>
              <input
                type="number"
                step="0.01"
                className="w-20 shrink-0 rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none"
                value={r.value === 0 ? "" : r.value}
                placeholder="0"
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value === "" ? 0 : parseFloat(e.target.value) } : x)))
                }
              />
              <span className="text-xs text-neutral-500 shrink-0">{currency}/m</span>
              <button
                className="text-rose-300 text-sm hover:text-rose-200 shrink-0"
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {hint && <p className="text-xs text-neutral-600 mt-1">{hint}</p>}
    </div>
  );
}
