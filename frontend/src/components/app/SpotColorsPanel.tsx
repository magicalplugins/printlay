import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { SpotColour, listSpotColours } from "../../api/spotColours";
import { formatErr } from "../../utils/apiError";

type Props = {
  /** Whether the operator has ticked "include cut lines" for the next
   *  Generate. Lifted into the parent (JobFiller) so it can pass the
   *  flag through to `generateOutput`. */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** Which spot-colour preset (from the shared `spot_colours` library)
   *  the cut lines should be drawn with on the next Generate. `null`
   *  falls back to the first preset / a standard CutContour. */
  selectedSpotColorId: string | null;
  onSelectedSpotColorIdChange: (next: string | null) => void;
};

/**
 * Spot colours panel (Jobs page).
 *
 * Uses the SAME spot-colour library as the Sheet Builder — managed once
 * in Settings → Spot Colours. Here we only:
 *
 *   1. Toggle "Include cut lines on output" (per-job, per-generate).
 *   2. Pick which library preset drives the cut path. The preset's
 *      NAME becomes the PDF Separation name the RIP routes to the cutter
 *      (Roland CutContour, Summa, etc.); its colour is the on-screen
 *      preview / DeviceRGB alternate.
 */
export default function SpotColorsPanel({
  enabled,
  onEnabledChange,
  selectedSpotColorId,
  onSelectedSpotColorIdChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [rows, setRows] = useState<SpotColour[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listSpotColours();
        if (cancelled) return;
        setRows(all.sort((a, b) => a.sort_order - b.sort_order));
        setLoaded(true);
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The effective preset: the explicit selection, else the first in the
  // library (there's no per-row "default" flag in the new system).
  const effectiveSelected = useMemo(
    () => rows.find((r) => r.id === selectedSpotColorId) ?? rows[0] ?? null,
    [rows, selectedSpotColorId]
  );

  // When enabling with no explicit choice, lock in the first preset so the
  // generate call sends a concrete id.
  useEffect(() => {
    if (enabled && !selectedSpotColorId && rows.length > 0) {
      onSelectedSpotColorIdChange(rows[0].id);
    }
  }, [enabled, selectedSpotColorId, rows, onSelectedSpotColorIdChange]);

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
                style={{ backgroundColor: r.display_color }}
                title={`${r.name} ${r.display_color}`}
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
                ? `Cut lines ON · ${effectiveSelected?.name ?? "CutContour"}`
                : `${rows.length} preset${rows.length === 1 ? "" : "s"}`}
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
                  RasterLink, Summa GoSign…) routes the path to the cutter
                  instead of inking it.
                </div>
              </div>
            </label>

            {enabled && (
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs text-neutral-400 font-medium">
                  Cut spot colour:
                </label>
                <select
                  value={effectiveSelected?.id ?? ""}
                  onChange={(e) =>
                    onSelectedSpotColorIdChange(e.target.value || null)
                  }
                  disabled={rows.length === 0}
                  className="flex-1 min-w-[8rem] rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1.5 text-sm focus:border-violet-500 focus:outline-none disabled:opacity-60"
                >
                  {rows.length === 0 ? (
                    <option value="">(no presets — add in Settings)</option>
                  ) : (
                    rows.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))
                  )}
                </select>
                {effectiveSelected && (
                  <span
                    className="h-6 w-6 rounded border border-neutral-700 shrink-0"
                    style={{ backgroundColor: effectiveSelected.display_color }}
                    title={effectiveSelected.display_color}
                  />
                )}
              </div>
            )}
          </div>

          <div className="text-[11px] text-neutral-500">
            The spot colour's <strong>name</strong> is what RIPs match on
            (e.g. <code>CutContour</code>). These presets are shared with the
            Sheet Builder.{" "}
            <Link
              to="/app/settings?tab=preferences"
              className="text-violet-300 hover:text-violet-200"
            >
              Manage spot colours in Settings →
            </Link>
          </div>

          {err && <div className="text-xs text-rose-300">{err}</div>}
        </div>
      )}
    </section>
  );
}
