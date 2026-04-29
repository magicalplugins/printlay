import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  RGB,
  SpotColor,
  createSpotColor,
  deleteSpotColor,
  listSpotColors,
  updateSpotColor,
} from "../../api/spotColors";
import { rgbCss, rgbToHex } from "../../api/colorProfiles";
import { formatErr } from "../../utils/apiError";
import RgbColorPicker from "./RgbColorPicker";

type Props = {
  /** Whether the operator has ticked "include cut lines" for the next
   *  Generate. Lifted into the parent (JobFiller) so it can pass the
   *  flag through to `generateOutput`. */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** Which library entry the cut lines should be drawn with on the
   *  next Generate. `null` means "fall back to the user's marked-default
   *  entry". The dropdown auto-syncs to the default whenever the
   *  default changes, so the operator only has to override it when
   *  switching machines. */
  selectedSpotColorId: string | null;
  onSelectedSpotColorIdChange: (next: string | null) => void;
};

/**
 * Spot Colours panel.
 *
 * Sits on the Jobs page right below the Colour Swaps panel and exposes
 * two distinct concerns to the operator:
 *
 *   1. The library: per-user catalogue of named PDF Separation colours
 *      they've configured for their cutters (Roland CutContour, Mimaki
 *      Through-cut, custom Score, etc.). Add / rename / recolour /
 *      delete. Exactly one entry can be flagged as the cut-line default.
 *      First load auto-seeds three industry-standard presets so the
 *      feature works out of the box.
 *
 *   2. The per-job toggle: "Include cut lines on output". When ticked,
 *      the next Generate adds a stroked outline around every slot in
 *      the chosen spot colour - the cut path the RIP routes to the
 *      cutter on a print/cut machine. The dropdown next to the toggle
 *      lets the operator pick a non-default entry for one-off jobs
 *      (e.g. a perforating cutter for postcards).
 */
export default function SpotColorsPanel({
  enabled,
  onEnabledChange,
  selectedSpotColorId,
  onSelectedSpotColorIdChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<SpotColor[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // Auto-load the library on mount so the collapsed header can show
  // a useful summary ("3 entries · default: CutContour") and so the
  // include-cut-lines dropdown has options ready immediately. Mirrors
  // the JobColorsPanel pattern - the user shouldn't have to expand
  // a panel for the active config to be visible.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listSpotColors();
        if (cancelled) return;
        setRows(all);
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const defaultEntry = useMemo(
    () => rows.find((r) => r.is_cut_line_default) ?? null,
    [rows]
  );

  // Auto-clear the explicit selection when it matches the default - keeps
  // the parent state minimal and means future default changes flow
  // through automatically without stale per-job overrides.
  useEffect(() => {
    if (
      selectedSpotColorId &&
      defaultEntry &&
      selectedSpotColorId === defaultEntry.id
    ) {
      onSelectedSpotColorIdChange(null);
    }
  }, [selectedSpotColorId, defaultEntry, onSelectedSpotColorIdChange]);

  const effectiveSelected =
    rows.find((r) => r.id === selectedSpotColorId) ?? defaultEntry;

  async function refresh() {
    try {
      const all = await listSpotColors();
      setRows(all);
    } catch (e) {
      setErr(formatErr(e));
    }
  }

  async function onAdd(payload: {
    name: string;
    rgb: RGB;
    is_cut_line_default: boolean;
  }) {
    setBusy(true);
    setErr(null);
    try {
      await createSpotColor(payload);
      await refresh();
      setAdding(false);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function onUpdate(
    id: string,
    patch: Partial<Pick<SpotColor, "name" | "rgb" | "is_cut_line_default">>
  ) {
    setBusy(true);
    setErr(null);
    try {
      await updateSpotColor(id, patch);
      await refresh();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  async function onMakeDefault(id: string) {
    await onUpdate(id, { is_cut_line_default: true });
  }

  async function onDelete(row: SpotColor) {
    if (!confirm(`Delete spot colour "${row.name}"?`)) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteSpotColor(row.id);
      // If we just deleted the active dropdown selection, reset to default.
      if (selectedSpotColorId === row.id) {
        onSelectedSpotColorIdChange(null);
      }
      await refresh();
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 backdrop-blur overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-900/60 transition"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex items-center gap-0.5">
            {rows.slice(0, 4).map((r) => (
              <span
                key={r.id}
                className="h-5 w-5 rounded-sm border border-neutral-700"
                style={{ backgroundColor: rgbCss(r.rgb) }}
                title={`${r.name} ${rgbToHex(r.rgb)}${
                  r.is_cut_line_default ? " · default" : ""
                }`}
              />
            ))}
            {rows.length === 0 && (
              <span
                className="h-5 w-5 rounded-sm border border-dashed border-neutral-700"
                aria-hidden="true"
              />
            )}
          </div>
          <div className="text-left min-w-0">
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Spot colours
            </div>
            <div className="text-sm text-neutral-300 mt-0.5 truncate">
              {!loaded
                ? "Loading…"
                : enabled
                ? `Cut lines ON · ${effectiveSelected?.name ?? "no default"}`
                : `${rows.length} entr${rows.length === 1 ? "y" : "ies"}${
                    defaultEntry ? ` · default ${defaultEntry.name}` : ""
                  }`}
            </div>
          </div>
        </div>
        <span
          className={`text-neutral-500 text-sm transition-transform ${
            open ? "rotate-180" : ""
          }`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>

      {open && (
        <div className="px-4 pb-4 space-y-4 border-t border-neutral-900 pt-4">
          {/* Per-job toggle - the only state on this panel that's
              actually job-scoped. Everything below it lives on the
              user's account library. */}
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-3 space-y-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => onEnabledChange(e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-neutral-600 bg-neutral-950 text-violet-500 focus:ring-violet-500/40 focus:ring-2"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-violet-200">
                  Include cut lines on output
                </div>
                <div className="text-[11px] text-neutral-400 mt-0.5">
                  Strokes the outline of every slot in the selected spot
                  colour so a print/cut RIP (Roland VersaWorks, Mimaki
                  RasterLink, Summa GoSign…) routes the path to the
                  cutter instead of inking it.
                </div>
              </div>
            </label>

            {enabled && (
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs text-neutral-400 font-medium">
                  Cut spot colour:
                </label>
                <select
                  value={selectedSpotColorId ?? defaultEntry?.id ?? ""}
                  onChange={(e) => {
                    const v = e.target.value || null;
                    onSelectedSpotColorIdChange(
                      v && defaultEntry && v === defaultEntry.id ? null : v
                    );
                  }}
                  disabled={busy || rows.length === 0}
                  className="flex-1 min-w-[8rem] rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm focus:border-violet-500 focus:outline-none disabled:opacity-60"
                >
                  {rows.length === 0 ? (
                    <option value="">(no entries — add one below)</option>
                  ) : (
                    rows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.is_cut_line_default ? " · default" : ""}
                      </option>
                    ))
                  )}
                </select>
                {effectiveSelected && (
                  <span
                    className="h-6 w-6 rounded border border-neutral-700 shrink-0"
                    style={{ backgroundColor: rgbCss(effectiveSelected.rgb) }}
                    title={rgbToHex(effectiveSelected.rgb)}
                  />
                )}
              </div>
            )}
          </div>

          {/* Library */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
                Library
              </div>
              <button
                type="button"
                onClick={() => setAdding(true)}
                disabled={busy}
                className="text-xs text-violet-300 hover:text-violet-200 disabled:opacity-50"
              >
                + Add spot colour
              </button>
            </div>

            {rows.length === 0 ? (
              <div className="text-xs text-neutral-500 py-2">
                No spot colours yet — adding your first one will seed
                Roland's <code>CutContour</code>, Mimaki's{" "}
                <code>Through-cut</code>, and a generic Score.
              </div>
            ) : (
              <ul className="space-y-2">
                {rows.map((row) =>
                  editingId === row.id ? (
                    <SpotColorEditor
                      key={row.id}
                      initial={row}
                      busy={busy}
                      onCancel={() => setEditingId(null)}
                      onSave={async (patch) => {
                        await onUpdate(row.id, patch);
                        setEditingId(null);
                      }}
                    />
                  ) : (
                    <SpotColorRow
                      key={row.id}
                      row={row}
                      isActiveSelection={
                        enabled && effectiveSelected?.id === row.id
                      }
                      onEdit={() => setEditingId(row.id)}
                      onMakeDefault={() => onMakeDefault(row.id)}
                      onDelete={() => onDelete(row)}
                    />
                  )
                )}
              </ul>
            )}

            {adding && (
              <div className="mt-3">
                <SpotColorEditor
                  initial={{
                    id: "",
                    name: "",
                    rgb: [255, 0, 255],
                    is_cut_line_default: rows.length === 0,
                    created_at: "",
                    updated_at: "",
                  }}
                  busy={busy}
                  onCancel={() => setAdding(false)}
                  onSave={async (patch) => {
                    await onAdd({
                      name: patch.name ?? "",
                      rgb: patch.rgb ?? [255, 0, 255],
                      is_cut_line_default: !!patch.is_cut_line_default,
                    });
                  }}
                />
              </div>
            )}
          </div>

          <div className="text-[11px] text-neutral-500">
            Tip: the spot colour's <strong>name</strong> is what RIPs match
            on (Roland: <code>CutContour</code>, Mimaki:{" "}
            <code>Through-cut</code>). The RGB is just for on-screen
            preview — your printer never inks it.{" "}
            <Link
              to="/app/settings"
              className="text-violet-300 hover:text-violet-200"
            >
              Manage in settings →
            </Link>
          </div>

          {err && <div className="text-xs text-rose-300">{err}</div>}
          {busy && <div className="text-xs text-neutral-500">Working…</div>}
        </div>
      )}
    </section>
  );
}

function SpotColorRow({
  row,
  isActiveSelection,
  onEdit,
  onMakeDefault,
  onDelete,
}: {
  row: SpotColor;
  isActiveSelection: boolean;
  onEdit: () => void;
  onMakeDefault: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border bg-neutral-950/60 px-3 py-2 ${
        isActiveSelection
          ? "border-violet-500/60 ring-1 ring-violet-500/20"
          : "border-neutral-800"
      }`}
    >
      <span
        className="h-7 w-7 rounded border border-black/30 shrink-0"
        style={{ backgroundColor: rgbCss(row.rgb) }}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm text-neutral-200 truncate flex items-center gap-2 flex-wrap">
          <span className="font-medium">{row.name}</span>
          {row.is_cut_line_default && (
            <span className="text-[10px] uppercase tracking-wider rounded px-1.5 py-0.5 bg-violet-500/20 text-violet-300 border border-violet-500/30">
              Cut default
            </span>
          )}
        </div>
        <div className="text-[11px] font-mono text-neutral-500 mt-0.5">
          {rgbToHex(row.rgb)}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {!row.is_cut_line_default && (
          <button
            type="button"
            onClick={onMakeDefault}
            className="text-[11px] text-neutral-400 hover:text-violet-300 px-1.5"
            title="Use this for cut lines by default"
          >
            Make default
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          className="text-neutral-500 hover:text-neutral-200 px-1.5"
          title="Edit"
          aria-label="Edit"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11.5 2.5l2 2L6 12l-3 1 1-3 7.5-7.5z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-neutral-600 hover:text-rose-400 px-1.5"
          title="Delete"
          aria-label="Delete"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M3 5h10M6 5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V5M5 5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 5" />
          </svg>
        </button>
      </div>
    </li>
  );
}

function SpotColorEditor({
  initial,
  busy,
  onCancel,
  onSave,
}: {
  initial: SpotColor;
  busy: boolean;
  onCancel: () => void;
  onSave: (
    patch: Partial<Pick<SpotColor, "name" | "rgb" | "is_cut_line_default">>
  ) => Promise<void>;
}) {
  const [name, setName] = useState(initial.name);
  const [rgb, setRgb] = useState<RGB>(initial.rgb);
  const [makeDefault, setMakeDefault] = useState(initial.is_cut_line_default);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const isCreate = initial.id === "";

  // Spot colour names go straight into the PDF Separation /N value, so
  // they have to satisfy the same constraint enforced server-side: leading
  // letter, then letters/digits/spaces/hyphens/underscores, max 64 chars.
  const NAME_RE = /^[A-Za-z][A-Za-z0-9 _\-]{0,63}$/;

  function trySave() {
    const trimmed = name.trim();
    if (!NAME_RE.test(trimmed)) {
      setLocalErr(
        "Name must start with a letter and only use letters, digits, spaces, hyphens or underscores."
      );
      return;
    }
    setLocalErr(null);
    void onSave({
      name: trimmed,
      rgb,
      is_cut_line_default: makeDefault,
    });
  }

  return (
    <li className="rounded-xl border border-violet-500/40 bg-neutral-950/60 p-3 space-y-3 list-none">
      <div className="text-xs font-semibold text-violet-300">
        {isCreate ? "Add spot colour" : `Edit "${initial.name}"`}
      </div>

      <label className="block">
        <div className="text-[11px] text-neutral-400 font-medium mb-1">
          Spot colour name (must match RIP exactly)
        </div>
        <input
          ref={nameRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          placeholder="CutContour"
          className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-2.5 py-1.5 text-sm font-mono focus:border-violet-500 focus:outline-none"
        />
      </label>

      <RgbColorPicker
        value={rgb}
        onChange={setRgb}
        label="Preview colour (DeviceRGB alternate)"
      />

      <label className="flex items-center gap-2 text-xs text-neutral-300 cursor-pointer">
        <input
          type="checkbox"
          checked={makeDefault}
          onChange={(e) => setMakeDefault(e.target.checked)}
          className="h-3.5 w-3.5 rounded border-neutral-600 bg-neutral-950 text-violet-500"
        />
        Use this as the default cut-line spot colour
      </label>

      {localErr && <div className="text-xs text-rose-300">{localErr}</div>}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs hover:border-neutral-500"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={trySave}
          disabled={busy || !name.trim()}
          className="rounded-md bg-violet-500 text-violet-50 px-3 py-1.5 text-xs font-semibold hover:bg-violet-400 disabled:opacity-50"
        >
          {isCreate ? "Add" : "Save"}
        </button>
      </div>
    </li>
  );
}
