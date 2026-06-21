import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
  CUT_STYLES,
  CUT_STYLES_BY_DESIGNER,
  CutStyle,
  DesignerMode,
  PricingProfile,
  Product,
  ProductInput,
  SizePreset,
  VinylOption,
  createProduct,
  deleteProduct,
  listPricingProfiles,
  listProducts,
  updateProduct,
} from "../../api/widget";
import { apiErrMessage } from "../../api/client";
import { SizeUnit, fmtLen, mmToUnit, unitToMm } from "../../utils/units";

const BLANK: ProductInput = {
  name: "Custom stickers",
  is_active: true,
  designer: "cutout",
  enabled_cut_styles: ["die_cut", "face", "keep_bg"],
  min_size_mm: 20,
  max_size_mm: 300,
  size_presets: [],
  allow_custom_size: true,
  corner_radius: 0.2,
  vinyl_types: [
    { key: "matte", label: "Matte" },
    { key: "gloss", label: "Gloss" },
  ],
  finishes: [],
  bleed_mm: 3,
  safe_mm: 4,
  show_filters: true,
  show_ai_styles: false,
  show_hand_edit: false,
  require_proof: false,
  proof_fee: 0,
  pricing_profile_id: null,
};

export default function WidgetProducts() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [profiles, setProfiles] = useState<PricingProfile[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; data: ProductInput } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const nav = useNavigate();

  const load = () => listProducts().then(setProducts).catch((e) => setErr(apiErrMessage(e)));
  useEffect(() => {
    load();
    listPricingProfiles().then(setProfiles).catch(() => setProfiles([]));
  }, []);

  const startEdit = (p: Product) =>
    setEditing({
      id: p.id,
      data: {
        name: p.name,
        is_active: p.is_active,
        designer: p.designer,
        enabled_cut_styles: p.enabled_cut_styles,
        min_size_mm: p.min_size_mm,
        max_size_mm: p.max_size_mm,
        size_presets: p.size_presets ?? [],
        allow_custom_size: p.allow_custom_size ?? true,
        corner_radius: p.corner_radius ?? 0.2,
        vinyl_types: p.vinyl_types,
        finishes: p.finishes,
        bleed_mm: p.bleed_mm,
        safe_mm: p.safe_mm,
        show_filters: p.show_filters ?? true,
        show_ai_styles: p.show_ai_styles ?? false,
        show_hand_edit: p.show_hand_edit ?? false,
        require_proof: p.require_proof ?? false,
        proof_fee: p.proof_fee ?? 0,
        pricing_profile_id: p.pricing_profile_id,
      },
    });

  const remove = async (p: Product) => {
    if (!confirm(`Delete "${p.name}"?`)) return;
    try {
      await deleteProduct(p.id);
      load();
    } catch (e) {
      setErr(apiErrMessage(e));
    }
  };

  if (editing) {
    return (
      <ProductEditor
        initial={editing.data}
        isNew={editing.id === null}
        profiles={profiles}
        onCancel={() => setEditing(null)}
        onSave={async (data) => {
          setErr(null);
          try {
            if (editing.id) await updateProduct(editing.id, data);
            else await createProduct(data);
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
      title="Products"
      subtitle="A product is what a store item links to — its cut styles, sizes, materials and pricing."
      actions={
        <button className={btnPrimary} onClick={() => setEditing({ id: null, data: { ...BLANK } })}>
          New product
        </button>
      }
    >
      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}
      {profiles.length === 0 && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200 mb-6">
          Create a pricing profile first so your products can be priced.
        </div>
      )}
      {products === null ? (
        <div className="text-neutral-500 text-sm">Loading…</div>
      ) : products.length === 0 ? (
        <div className={emptyCls}>No products yet. Create one to start designing.</div>
      ) : (
        <div className="space-y-2">
          {products.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-4 rounded-xl border border-neutral-700/60 bg-neutral-800/30 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-sm truncate">{p.name}</h3>
                  {!p.is_active && (
                    <span className="shrink-0 text-[10px] uppercase tracking-widest text-neutral-500 border border-neutral-700 rounded-full px-2 py-0.5">
                      Inactive
                    </span>
                  )}
                </div>
                <p className="text-xs text-neutral-400 mt-0.5 truncate">
                  {p.designer === "canvas" ? "Shaped designer" : "Cut-out"} ·{" "}
                  {p.enabled_cut_styles.length} {p.designer === "canvas" ? "shape" : "cut style"}
                  {p.enabled_cut_styles.length > 1 ? "s" : ""} · {mmToUnit(p.min_size_mm, "cm")}–{fmtLen(p.max_size_mm, "cm")}
                  {" · "}
                  <span className={p.pricing_profile_id ? "text-emerald-400" : "text-amber-400"}>
                    {p.pricing_profile_id ? "Priced" : "No pricing"}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button className={btnSecondary} onClick={() => startEdit(p)}>
                  Edit
                </button>
                <button
                  className={btnSecondary}
                  onClick={() => nav(`/app/widget/preview?product=${p.id}`)}
                >
                  Preview
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

function ProductEditor({
  initial,
  isNew,
  profiles,
  onCancel,
  onSave,
}: {
  initial: ProductInput;
  isNew: boolean;
  profiles: PricingProfile[];
  onCancel: () => void;
  onSave: (d: ProductInput) => Promise<void>;
}) {
  const [d, setD] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [unit, setUnit] = useState<SizeUnit>("cm");
  const dispStep = unit === "cm" ? 0.1 : 1;

  const allowedStyles = CUT_STYLES_BY_DESIGNER[d.designer];
  const shapeOptions = CUT_STYLES.filter((s) => allowedStyles.includes(s.key));

  const setDesigner = (designer: DesignerMode) => {
    // Keep only cut styles valid for the new experience; default to all of them.
    const keep = d.enabled_cut_styles.filter((s) =>
      CUT_STYLES_BY_DESIGNER[designer].includes(s)
    );
    setD({
      ...d,
      designer,
      enabled_cut_styles: keep.length ? keep : [...CUT_STYLES_BY_DESIGNER[designer]],
    });
  };

  const toggleStyle = (s: CutStyle) => {
    const has = d.enabled_cut_styles.includes(s);
    const next = has
      ? d.enabled_cut_styles.filter((x) => x !== s)
      : [...d.enabled_cut_styles, s];
    setD({ ...d, enabled_cut_styles: next.length ? next : d.enabled_cut_styles });
  };

  // Size fields are stored in mm but shown/entered in the chosen unit.
  const dispMm = (mm: number) => mmToUnit(mm, unit);
  const numMm = (k: keyof ProductInput) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setD({ ...d, [k]: Math.round(unitToMm(parseFloat(e.target.value) || 0, unit) * 10) / 10 });

  const save = async () => {
    setSaving(true);
    try {
      await onSave(d);
    } catch {
      /* surfaced by parent */
    } finally {
      setSaving(false);
    }
  };

  return (
    <WidgetShell
      title={isNew ? "New product" : "Edit product"}
      actions={
        <>
          <button className={btnSecondary} onClick={onCancel}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={saving} onClick={save}>
            {saving ? "Saving…" : "Save product"}
          </button>
        </>
      }
    >
      <div className={`${card} space-y-5`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Product name">
            <input className={inputCls} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </Field>
          <Field label="Pricing profile">
            <select
              className={`${inputCls} ${!d.pricing_profile_id ? "border-amber-600" : ""}`}
              value={d.pricing_profile_id ?? ""}
              onChange={(e) => setD({ ...d, pricing_profile_id: e.target.value || null })}
            >
              <option value="">— select a profile —</option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <label className={labelCls}>Design experience</label>
          <div className="grid sm:grid-cols-2 gap-3">
            {(
              [
                {
                  key: "cutout",
                  title: "Cut-out sticker",
                  body: "Customer uploads one piece of artwork. Background is removed and a die-cut / face cut line is generated automatically.",
                },
                {
                  key: "canvas",
                  title: "Shaped designer",
                  body: "Full canvas: customer adds text, multiple images and layers on a circle/oval/square/rectangle. The shape is the cut line.",
                },
              ] as const
            ).map((opt) => (
              <button
                key={opt.key}
                type="button"
                onClick={() => setDesigner(opt.key)}
                className={`text-left rounded-xl border p-4 transition ${
                  d.designer === opt.key
                    ? "border-violet-500/50 bg-violet-500/10"
                    : "border-neutral-700 hover:border-neutral-500"
                }`}
              >
                <div className="font-medium text-sm flex items-center gap-2">
                  {opt.title}
                  {d.designer === opt.key && <span className="text-violet-300 text-xs">✓</span>}
                </div>
                <p className="text-xs text-neutral-400 mt-1">{opt.body}</p>
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.show_filters ?? true}
              onChange={(e) => setD({ ...d, show_filters: e.target.checked })}
              className="accent-violet-600 w-4 h-4"
            />
            <span className={labelCls + " !mb-0"}>Show photo filters to customers</span>
          </label>
          <p className="text-xs text-neutral-500 mt-1 ml-6">
            When enabled, customers can apply Instagram-style filters to their artwork before ordering.
            Only applies to cut-out products (background removal / face).
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.show_ai_styles ?? false}
              onChange={(e) => setD({ ...d, show_ai_styles: e.target.checked })}
              className="accent-violet-600 w-4 h-4"
            />
            <span className={labelCls + " !mb-0"}>Show AI styles to customers</span>
          </label>
          <p className="text-xs text-neutral-500 mt-1 ml-6">
            Cartoon, caricature, pencil, anime, pop art, watercolour and custom prompts.
            Uses your OpenAI API key (set in Settings → Preferences).
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.show_hand_edit ?? false}
              onChange={(e) => setD({ ...d, show_hand_edit: e.target.checked })}
              className="accent-violet-600 w-4 h-4"
            />
            <span className={labelCls + " !mb-0"}>Show hand-edit cut line to customers</span>
          </label>
          <p className="text-xs text-neutral-500 mt-1 ml-6">
            Let customers manually adjust the cut line with a brush tool.
          </p>
        </div>

        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={d.require_proof ?? false}
              onChange={(e) => setD({ ...d, require_proof: e.target.checked })}
              className="accent-violet-600 w-4 h-4"
            />
            <span className={labelCls + " !mb-0"}>Require proof approval before printing</span>
          </label>
          <p className="text-xs text-neutral-500 mt-1 ml-6">
            Customers choose to self-approve or request a manual proof review.
          </p>
          {(d.require_proof ?? false) && (
            <div className="mt-2 ml-6">
              <label className={labelCls}>Proof fee ({profiles.find((pr) => pr.id === d.pricing_profile_id)?.currency ?? "GBP"})</label>
              <input
                type="number"
                min={0}
                step={0.01}
                className={inputCls + " w-32"}
                value={d.proof_fee ?? 0}
                onChange={(e) => setD({ ...d, proof_fee: parseFloat(e.target.value) || 0 })}
              />
              <p className="text-xs text-neutral-500 mt-1">Flat fee added when customer requests manual proof.</p>
            </div>
          )}
        </div>

        <div>
          <label className={labelCls}>
            {d.designer === "canvas"
              ? "Artboard shapes customers can choose"
              : "Cut styles customers can choose"}
          </label>
          {d.designer === "canvas" ? (
            <p className="text-xs text-neutral-500 mb-2 -mt-0.5">
              Square gives a rectangular artboard, circle a round one. Customers can
              unlock a second dimension in the designer to make a rectangle or oval.
            </p>
          ) : (
            <p className="text-xs text-neutral-500 mb-2 -mt-0.5">
              Cut-out products generate the cut line from the artwork — die-cut around
              the subject, a face cut, or "keep background" (a rectangle cut around the
              whole uploaded image, no background removal).
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {shapeOptions.map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleStyle(s.key)}
                className={`rounded-full px-3.5 py-1.5 text-sm border transition ${
                  d.enabled_cut_styles.includes(s.key)
                    ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3">
          <label className={labelCls} style={{ margin: 0 }}>Units</label>
          <div className="inline-flex rounded-lg border border-neutral-700 overflow-hidden text-sm">
            {(["cm", "mm"] as SizeUnit[]).map((u) => (
              <button
                key={u}
                type="button"
                onClick={() => setUnit(u)}
                className={`px-3.5 py-1.5 transition ${
                  unit === u ? "bg-violet-500/20 text-violet-200" : "text-neutral-400 hover:text-neutral-200"
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>

        <div className={`grid gap-4 ${d.designer === "canvas" ? "sm:grid-cols-4" : "sm:grid-cols-2"}`}>
          <Field label={`Min size (${unit})`}>
            <input type="number" step={dispStep} className={inputCls} value={dispMm(d.min_size_mm)} onChange={numMm("min_size_mm")} />
          </Field>
          <Field label={`Max size (${unit})`}>
            <input type="number" step={dispStep} className={inputCls} value={dispMm(d.max_size_mm)} onChange={numMm("max_size_mm")} />
          </Field>
          {d.designer === "canvas" && (
            <>
              <Field label={`Bleed (${unit})`} hint="auto-applied">
                <input type="number" step={dispStep} className={inputCls} value={dispMm(d.bleed_mm)} onChange={numMm("bleed_mm")} />
              </Field>
              <Field label={`Safe area (${unit})`}>
                <input type="number" step={dispStep} className={inputCls} value={dispMm(d.safe_mm)} onChange={numMm("safe_mm")} />
              </Field>
            </>
          )}
        </div>

        <SizePresetEditor
          designer={d.designer}
          unit={unit}
          presets={d.size_presets}
          setPresets={(presets) => setD({ ...d, size_presets: presets })}
          allowCustom={d.allow_custom_size}
          setAllowCustom={(v) => setD({ ...d, allow_custom_size: v })}
        />

        {d.designer === "canvas" && (
          <>
            <div>
              <label className={labelCls}>
                Default corner radius{" "}
                <span className="text-neutral-500">({Math.round(d.corner_radius * 100)}%)</span>
              </label>
              <p className="text-xs text-neutral-500 mb-2 -mt-0.5">
                Rounding for square/rectangle stickers. 0% = sharp corners, 100% = fully
                rounded. Customers can adjust this in the designer.
              </p>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={d.corner_radius}
                onChange={(e) => setD({ ...d, corner_radius: parseFloat(e.target.value) })}
                className="w-full max-w-xs accent-violet-500"
              />
            </div>
          </>
        )}

        <label className="flex items-center gap-2 text-sm text-neutral-300">
          <input
            type="checkbox"
            checked={d.is_active}
            onChange={(e) => setD({ ...d, is_active: e.target.checked })}
            className="accent-violet-500"
          />
          Active (available to customers)
        </label>
      </div>

      <ProfileOptionsSelector
        title="Materials customers can choose"
        hint="Select which materials from the pricing profile to offer for this product."
        profileId={d.pricing_profile_id}
        profiles={profiles}
        optionSource="vinyl_surcharges"
        selected={d.vinyl_types}
        setSelected={(r) => setD({ ...d, vinyl_types: r })}
      />
      <ProfileOptionsSelector
        title="Finishes customers can choose"
        hint="Select which finishes from the pricing profile to offer for this product."
        profileId={d.pricing_profile_id}
        profiles={profiles}
        optionSource="finish_surcharges"
        selected={d.finishes}
        setSelected={(r) => setD({ ...d, finishes: r })}
      />
    </WidgetShell>
  );
}

function SizePresetEditor({
  designer,
  unit,
  presets,
  setPresets,
  allowCustom,
  setAllowCustom,
}: {
  designer: DesignerMode;
  unit: SizeUnit;
  presets: SizePreset[];
  setPresets: (p: SizePreset[]) => void;
  allowCustom: boolean;
  setAllowCustom: (v: boolean) => void;
}) {
  const [w, setW] = useState("");
  const [h, setH] = useState("");
  const cutout = designer === "cutout";

  const add = () => {
    const wv = parseFloat(w);
    const hv = h.trim() === "" ? wv : parseFloat(h);
    if (!Number.isFinite(wv) || wv <= 0 || !Number.isFinite(hv) || hv <= 0) return;
    const toMm = (v: number) => Math.round(unitToMm(v, unit) * 10) / 10;
    setPresets([...presets, { width_mm: toMm(wv), height_mm: toMm(hv) }]);
    setW("");
    setH("");
  };

  return (
    <div>
      <label className={labelCls}>Fixed sizes</label>
      <p className="text-xs text-neutral-500 mb-2 -mt-0.5">
        {cutout
          ? `Offer specific sizes customers can pick (e.g. 2${unit === "cm" ? "" : "0"}, 3${unit === "cm" ? "" : "0"} ${unit}). For cut-out stickers this sets the longest side — the artwork's aspect ratio is preserved. Toggle off "Allow custom size" to force one of these.`
          : `Offer specific sizes (in ${unit}). Leave height blank for a square / circle. Toggle off "Allow custom size" to force customers to pick a fixed size.`}
      </p>
      {presets.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {presets.map((p, i) => (
            <span
              key={i}
              className="inline-flex items-center gap-1.5 rounded-full border border-neutral-700 bg-neutral-800/40 pl-3 pr-1.5 py-1 text-sm"
            >
              {cutout
                ? fmtLen(Math.max(p.width_mm, p.height_mm), unit)
                : p.width_mm === p.height_mm
                  ? fmtLen(p.width_mm, unit)
                  : `${mmToUnit(p.width_mm, unit)}×${fmtLen(p.height_mm, unit)}`}
              <button
                type="button"
                className="text-neutral-500 hover:text-rose-300 px-1"
                onClick={() => setPresets(presets.filter((_, j) => j !== i))}
                aria-label="Remove size"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          step={unit === "cm" ? 0.1 : 1}
          className={`${inputCls} w-28`}
          placeholder={cutout ? `Size ${unit}` : `Width ${unit}`}
          value={w}
          onChange={(e) => setW(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
        />
        {!cutout && (
          <>
            <span className="text-neutral-600">×</span>
            <input
              type="number"
              step={unit === "cm" ? 0.1 : 1}
              className={`${inputCls} w-28`}
              placeholder="Height (opt)"
              value={h}
              onChange={(e) => setH(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
          </>
        )}
        <button className={btnSecondary} type="button" onClick={add}>
          Add size
        </button>
      </div>
      <label className="flex items-center gap-2 text-sm text-neutral-300 mt-3">
        <input
          type="checkbox"
          checked={allowCustom}
          onChange={(e) => setAllowCustom(e.target.checked)}
          className="accent-violet-500"
        />
        Allow custom size (customer can type their own within min/max)
      </label>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className={labelCls}>{label}</label>
      {children}
      {hint && <p className="text-xs text-neutral-600 mt-1">{hint}</p>}
    </div>
  );
}

function ProfileOptionsSelector({
  title,
  hint,
  profileId,
  profiles,
  optionSource,
  selected,
  setSelected,
}: {
  title: string;
  hint: string;
  profileId: string | null;
  profiles: PricingProfile[];
  optionSource: "vinyl_surcharges" | "finish_surcharges";
  selected: VinylOption[];
  setSelected: (r: VinylOption[]) => void;
}) {
  const profile = profiles.find((p) => p.id === profileId);
  const surchargeMap = profile?.[optionSource];
  const availableKeys = surchargeMap ? Object.keys(surchargeMap) : [];
  const availableSet = new Set(availableKeys);

  // Auto-remove stale entries that no longer exist in the profile
  useEffect(() => {
    if (!profileId || availableKeys.length === 0) return;
    const cleaned = selected.filter((s) => availableSet.has(s.key));
    if (cleaned.length !== selected.length) {
      setSelected(cleaned);
    }
  }, [profileId, availableKeys.join(",")]);

  const selectedKeys = new Set(selected.map((s) => s.key));

  const toggle = (key: string) => {
    if (selectedKeys.has(key)) {
      setSelected(selected.filter((s) => s.key !== key));
    } else {
      setSelected([...selected, { key, label: key }]);
    }
  };

  return (
    <div className={`${card} mt-6`}>
      <div className="mb-3">
        <h3 className="font-semibold text-sm uppercase tracking-wide text-violet-300">{title}</h3>
        <p className="text-xs text-neutral-500 mt-0.5 max-w-lg">{hint}</p>
      </div>
      {!profileId ? (
        <p className="text-sm text-amber-400">Select a pricing profile first to see available options.</p>
      ) : availableKeys.length === 0 ? (
        <p className="text-sm text-neutral-500">
          No {optionSource === "vinyl_surcharges" ? "materials" : "finishes"} defined in this pricing profile.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {availableKeys.map((key) => {
            const isActive = selectedKeys.has(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggle(key)}
                className={`px-4 py-2 rounded-full border text-sm font-medium transition ${
                  isActive
                    ? "border-violet-500 bg-violet-500/10 text-violet-200"
                    : "border-neutral-700 text-neutral-400 hover:border-neutral-500 hover:text-neutral-200"
                }`}
              >
                {key}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
