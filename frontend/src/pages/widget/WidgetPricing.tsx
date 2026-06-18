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

const BLANK: PricingProfileInput = {
  name: "New pricing",
  currency: "GBP",
  sheet_width_mm: 560,
  price_per_metre: 6,
  gap_mm: 3,
  margin_pct: 200,
  handling_fee: 0,
  min_order_price: 5,
  vinyl_surcharges: null,
  finish_surcharges: null,
  quantity_breaks: [],
};

type SurchargeRow = { key: string; pct: number };

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
        vinyl_surcharges: p.vinyl_surcharges,
        finish_surcharges: p.finish_surcharges,
        quantity_breaks: p.quantity_breaks,
      },
    });

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
                      {p.quantity_breaks.length} volume discount
                      {p.quantity_breaks.length > 1 ? "s" : ""}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <button className={btnSecondary} onClick={() => startEdit(p)}>
                  Edit
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
  return Object.entries(m).map(([key, frac]) => ({ key, pct: Math.round(frac * 100) }));
}
function rowsToMap(rows: SurchargeRow[]): Record<string, number> | null {
  const clean = rows.filter((r) => r.key.trim());
  if (clean.length === 0) return null;
  return Object.fromEntries(clean.map((r) => [r.key.trim(), (r.pct || 0) / 100]));
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
            <input
              className={inputCls}
              maxLength={3}
              value={d.currency}
              onChange={(e) => setD({ ...d, currency: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="Media / roll width (mm)" hint="usable print width">
            <input type="number" className={inputCls} value={d.sheet_width_mm} onChange={num("sheet_width_mm")} />
          </Field>
          <Field label="Price per metre" hint="media cost per linear metre">
            <input type="number" className={inputCls} value={d.price_per_metre} onChange={num("price_per_metre")} />
          </Field>
          <Field label="Gap between stickers (mm)">
            <input type="number" className={inputCls} value={d.gap_mm} onChange={num("gap_mm")} />
          </Field>
          <Field label="Margin %" hint="markup on media cost, e.g. 200 = 3×">
            <input type="number" className={inputCls} value={d.margin_pct} onChange={num("margin_pct")} />
          </Field>
          <Field label="Handling fee" hint="flat per-order">
            <input type="number" className={inputCls} value={d.handling_fee} onChange={num("handling_fee")} />
          </Field>
          <Field label="Minimum order price">
            <input type="number" className={inputCls} value={d.min_order_price} onChange={num("min_order_price")} />
          </Field>
        </div>
      </div>

      <SurchargeEditor
        title="Material surcharges"
        hint="Extra cost for premium materials, as a % on media cost. The key must match the product's material key (e.g. holographic)."
        rows={vinylRows}
        setRows={setVinylRows}
      />
      <SurchargeEditor
        title="Finish surcharges"
        hint="Extra cost for finishes (e.g. laminate), as a %. Key must match the product's finish key."
        rows={finishRows}
        setRows={setFinishRows}
      />

      <div className={`${card} mt-6`}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm">Volume discounts</h3>
            <p className="text-xs text-neutral-500 mt-0.5">Highest matching break applies.</p>
          </div>
          <button
            className={btnSecondary}
            onClick={() => setBreaks([...breaks, { min_qty: 0, discount_pct: 0 }])}
          >
            Add break
          </button>
        </div>
        {breaks.length === 0 ? (
          <p className="text-sm text-neutral-500">No volume discounts.</p>
        ) : (
          <div className="space-y-2">
            {breaks.map((b, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-xs text-neutral-500 w-14">From qty</span>
                <input
                  type="number"
                  className={`${inputCls} w-24`}
                  value={b.min_qty}
                  onChange={(e) =>
                    setBreaks(breaks.map((x, j) => (j === i ? { ...x, min_qty: parseInt(e.target.value) || 0 } : x)))
                  }
                />
                <input
                  type="number"
                  className={`${inputCls} w-24`}
                  value={b.discount_pct}
                  onChange={(e) =>
                    setBreaks(breaks.map((x, j) => (j === i ? { ...x, discount_pct: parseFloat(e.target.value) || 0 } : x)))
                  }
                />
                <span className="text-xs text-neutral-500">% off</span>
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
    </WidgetShell>
  );
}

function SurchargeEditor({
  title,
  hint,
  rows,
  setRows,
}: {
  title: string;
  hint: string;
  rows: SurchargeRow[];
  setRows: (r: SurchargeRow[]) => void;
}) {
  return (
    <div className={`${card} mt-6`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-semibold text-sm">{title}</h3>
          <p className="text-xs text-neutral-500 mt-0.5 max-w-md">{hint}</p>
        </div>
        <button className={btnSecondary} onClick={() => setRows([...rows, { key: "", pct: 0 }])}>
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
                className={`${inputCls} flex-1`}
                placeholder="key (e.g. holographic)"
                value={r.key}
                onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <input
                type="number"
                className={`${inputCls} w-24`}
                value={r.pct}
                onChange={(e) =>
                  setRows(rows.map((x, j) => (j === i ? { ...x, pct: parseFloat(e.target.value) || 0 } : x)))
                }
              />
              <span className="text-xs text-neutral-500">%</span>
              <button
                className="text-rose-300 text-sm hover:text-rose-200"
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
