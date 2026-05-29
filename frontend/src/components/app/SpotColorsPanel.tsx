import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { SpotColour, listSpotColours } from "../../api/spotColours";
import { formatErr } from "../../utils/apiError";
import SpotColourRow, { spotDisplayColor } from "./SpotColourRow";

type Props = {
  /** Whether the operator has ticked "include cut lines" for the next
   *  Generate. Lifted into the parent (JobFiller). */
  enabled: boolean;
  onEnabledChange: (next: boolean) => void;
  /** Cut-line spot colour — a spot **name** (e.g. `CutContour`, a RIP
   *  Separation) or a `#RRGGBB` custom colour. */
  cutLineSpot: string;
  onCutLineSpotChange: (next: string) => void;
  /** Registration-mark spot colour, same name-or-hex form. Only used when
   *  the job's template has registration marks baked in. */
  markSpot: string;
  onMarkSpotChange: (next: string) => void;
};

/**
 * Spot colours panel (Jobs page).
 *
 * Same picker as the Sheet Builder — colours are chosen here (any colour, or
 * a named spot from the shared library managed in Settings). A spot **name**
 * becomes the PDF Separation name a print/cut RIP routes to the cutter; a
 * custom hex is honoured as a colour. Works even with an empty library
 * because the built-in CutContour / Score / Through-cut presets are always
 * offered.
 */
export default function SpotColorsPanel({
  enabled,
  onEnabledChange,
  cutLineSpot,
  onCutLineSpotChange,
  markSpot,
  onMarkSpotChange,
}: Props) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<SpotColour[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await listSpotColours();
        if (cancelled) return;
        setRows(all.sort((a, b) => a.sort_order - b.sort_order));
      } catch (e) {
        if (!cancelled) setErr(formatErr(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 backdrop-blur overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-neutral-900/60 transition"
        aria-expanded={open}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span
            className="h-5 w-5 rounded-sm border border-neutral-700 shrink-0"
            style={{ backgroundColor: spotDisplayColor(cutLineSpot, rows) }}
            title={cutLineSpot}
          />
          <div className="text-left min-w-0">
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Spot colours
            </div>
            <div className="text-sm text-neutral-300 mt-0.5 truncate">
              {enabled ? `Cut lines ON · ${cutLineSpot}` : "Cut lines off"}
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
          <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-3">
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
                Strokes the outline of every slot in the chosen spot colour so
                a print/cut RIP (Roland VersaWorks, Mimaki RasterLink, Summa
                GoSign…) routes the path to the cutter instead of inking it.
              </div>
            </div>
          </label>

          <div className="space-y-3">
            <SpotColourRow
              label="Cut lines"
              value={cutLineSpot}
              spots={rows}
              onChange={onCutLineSpotChange}
            />
            <SpotColourRow
              label="Marks (registration)"
              value={markSpot}
              spots={rows}
              onChange={onMarkSpotChange}
            />
          </div>

          <p className="text-[11px] text-neutral-500">
            Pick any colour (becomes custom) or select a spot name. A spot{" "}
            <strong>name</strong> (e.g. <code>CutContour</code>) is what RIPs
            match on. Registration marks are set on the template; this only
            colours them.{" "}
            <Link
              to="/app/settings?tab=preferences"
              className="text-violet-300 hover:text-violet-200"
            >
              Manage spots →
            </Link>
          </p>

          {err && <div className="text-xs text-rose-300">{err}</div>}
        </div>
      )}
    </section>
  );
}
