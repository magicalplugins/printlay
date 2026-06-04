import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  bulkDeleteOutputs,
  deleteOutput,
  downloadOutputUrl,
  listOutputs,
  Output,
} from "../api/outputs";
import { listTemplates, Template } from "../api/templates";
import { listJobs, Job } from "../api/jobs";
import { bulkThumbnails } from "../api/catalogue";
import { useMe } from "../auth/MeProvider";
import QuickPreview from "../components/app/QuickPreview";
import UsageHint from "../components/app/UsageHint";
import {
  humanizeMinutes,
  minutesSavedForOutput,
  TIME_SAVED_DEFAULTS,
} from "../utils/timeSaved";

type ViewMode = "grid" | "list";
const VIEW_KEY = "printlay.outputsView";

export default function Outputs() {
  const { me } = useMe();
  const [items, setItems] = useState<Output[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search] = useSearchParams();
  const highlight = search.get("highlight");

  const [templates, setTemplates] = useState<Template[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [view, setView] = useState<ViewMode>(() => {
    try { return (localStorage.getItem(VIEW_KEY) as ViewMode) || "list"; }
    catch { return "list"; }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const showTimeSaved = me?.time_saved_show_enabled ?? true;
  const timePrefs = {
    setupMinutes: me?.time_saved_setup_minutes ?? TIME_SAVED_DEFAULTS.setupMinutes,
    perSlotSeconds: me?.time_saved_per_slot_seconds ?? TIME_SAVED_DEFAULTS.perSlotSeconds,
  };

  function load() {
    listOutputs().then(setItems).catch((e) => setErr(String(e)));
  }
  useEffect(() => {
    load();
    listTemplates().then(setTemplates).catch(() => {});
    listJobs().then(setJobs).catch(() => {});
  }, []);

  const tplMap = useMemo(() => new Map(templates.map((t) => [t.id, t])), [templates]);
  const jobMap = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);

  // Build a thumbnail map for all assets referenced in any job's assignments
  // so QuickPreview can show the artwork rather than blank slots.
  const [thumbMap, setThumbMap] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!jobs.length) return;
    const assetIds = new Set<string>();
    for (const j of jobs) {
      for (const a of Object.values(j.assignments)) {
        if (a.asset_id) assetIds.add(a.asset_id);
      }
    }
    if (assetIds.size === 0) return;
    bulkThumbnails([...assetIds]).then(setThumbMap).catch(() => {});
  }, [jobs]);

  function slotImagesFor(job: Job): Record<number, string> {
    const map: Record<number, string> = {};
    for (const [slotIdx, assignment] of Object.entries(job.assignments)) {
      const url = thumbMap[assignment.asset_id];
      if (url) map[Number(slotIdx)] = url;
    }
    return map;
  }

  function switchView(v: ViewMode) {
    setView(v);
    setSelected(new Set());
    try { localStorage.setItem(VIEW_KEY, v); } catch {}
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function toggleAll() {
    if (!items) return;
    setSelected((prev) => prev.size === items.length ? new Set() : new Set(items.map((o) => o.id)));
  }

  async function onDownload(id: string) {
    const win = window.open("", "_blank");
    try {
      const { url } = await downloadOutputUrl(id);
      if (win && !win.closed) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      if (win && !win.closed) win.close();
      setErr(String(e));
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this output PDF?")) return;
    await deleteOutput(id);
    setSelected((prev) => { const n = new Set(prev); n.delete(id); return n; });
    load();
  }

  async function onDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} output${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await bulkDeleteOutputs([...selected]);
      setSelected(new Set());
      load();
    } catch (e) {
      setErr(String(e));
    } finally {
      setDeleting(false);
    }
  }

  function tplForOutput(o: Output): Template | undefined {
    const job = jobMap.get(o.job_id);
    if (!job) return undefined;
    return tplMap.get(job.template_id);
  }

  function jobForOutput(o: Output): Job | undefined {
    return jobMap.get(o.job_id);
  }

  const allSelected = !!items && items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4 mb-8">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Outputs</h1>
            <UsageHint metric="exports_this_month" />
          </div>
          <p className="text-neutral-400 mt-1 text-sm">
            Print-ready PDFs you&apos;ve generated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-neutral-800 p-0.5 bg-neutral-900/60">
            <button
              type="button"
              onClick={() => switchView("grid")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === "grid" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
              }`}
              title="Grid view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={view === "grid" ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              type="button"
              onClick={() => switchView("list")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === "list" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
              }`}
              title="List view"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={view === "list" ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round">
                <line x1="3" y1="6" x2="21" y2="6" />
                <line x1="3" y1="12" x2="21" y2="12" />
                <line x1="3" y1="18" x2="21" y2="18" />
              </svg>
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
        </div>
      </div>

      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      {/* Selection toolbar */}
      {someSelected && (
        <div className="flex items-center gap-3 mb-4 rounded-lg bg-violet-500/10 border border-violet-500/30 px-4 py-2.5">
          <span className="text-sm text-violet-300 font-medium">
            {selected.size} selected
          </span>
          <button onClick={toggleAll} className="text-xs text-neutral-400 hover:text-white">
            {allSelected ? "Deselect all" : "Select all"}
          </button>
          <div className="flex-1" />
          <button
            onClick={onDeleteSelected}
            disabled={deleting}
            className="rounded-md bg-rose-600 hover:bg-rose-500 text-white px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {deleting ? "Deleting..." : `Delete (${selected.size})`}
          </button>
        </div>
      )}

      {items === null ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 rounded-xl border border-neutral-800 bg-neutral-900/50 animate-pulse" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
          Nothing yet. Fill a job and click &quot;Generate PDF &rarr;&quot;.
        </div>
      ) : view === "grid" ? (
        /* ── GRID VIEW ── */
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((o) => {
            const isSelected = selected.has(o.id);
            const tpl = tplForOutput(o);
            const job = jobForOutput(o);
            return (
              <div
                key={o.id}
                className={`group relative rounded-xl border p-5 space-y-2 transition ${
                  highlight === o.id ? "border-emerald-500/60 bg-emerald-500/5" :
                  isSelected ? "border-violet-400 ring-1 ring-violet-400/50 bg-neutral-900/50" :
                  "border-neutral-800 bg-neutral-900/50 hover:border-neutral-700"
                }`}
              >
                {/* Checkbox */}
                <div className="absolute top-3 left-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(o.id)}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-800 text-violet-500 focus:ring-violet-500 cursor-pointer"
                  />
                </div>
                <div className="flex items-start justify-between gap-2 ml-6">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate text-sm">{o.name}</div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {(o.file_size / 1024).toFixed(0)} KB · {o.slots_filled}/{o.slots_total} slots
                    </div>
                    <div className="text-xs text-neutral-600 mt-0.5">
                      {new Date(o.created_at).toLocaleDateString()}
                    </div>
                    {showTimeSaved && (
                      <div className="text-[11px] text-violet-300/70 mt-1">
                        ≈ {humanizeMinutes(minutesSavedForOutput(o.slots_filled, timePrefs))} saved
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-0.5 shrink-0">
                    {tpl && (
                      <QuickPreview
                        pageWidth={tpl.page_width}
                        pageHeight={tpl.page_height}
                        shapes={tpl.shapes}
                        slotImages={job ? slotImagesFor(job) : undefined}
                      />
                    )}
                    <button
                      onClick={() => onDelete(o.id)}
                      className="text-xs text-neutral-500 hover:text-rose-400 px-1.5 py-1 opacity-0 group-hover:opacity-100 transition"
                      title="Delete"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                <button
                  onClick={() => onDownload(o.id)}
                  className="w-full rounded-md bg-white/90 px-3 py-2 text-xs font-semibold text-neutral-950 hover:bg-white transition"
                >
                  Download
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── LIST VIEW ── */
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-violet-500 focus:ring-violet-500 cursor-pointer"
                  />
                </th>
                <th className="text-left font-normal px-3 py-2">Name</th>
                <th className="text-right font-normal px-3 py-2 hidden sm:table-cell">Slots</th>
                <th className="text-right font-normal px-3 py-2 hidden sm:table-cell">Size</th>
                <th className="text-right font-normal px-3 py-2 hidden md:table-cell">Date</th>
                <th className="w-28"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {items.map((o) => {
                const isSelected = selected.has(o.id);
                const tpl = tplForOutput(o);
                const job = jobForOutput(o);
                return (
                  <tr
                    key={o.id}
                    className={`transition ${
                      highlight === o.id ? "bg-emerald-500/5" :
                      isSelected ? "bg-violet-500/[0.07]" : "hover:bg-neutral-900/40"
                    }`}
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(o.id)}
                        className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-violet-500 focus:ring-violet-500 cursor-pointer"
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-white truncate max-w-[300px]">{o.name}</span>
                        {tpl && (
                          <QuickPreview
                            pageWidth={tpl.page_width}
                            pageHeight={tpl.page_height}
                            shapes={tpl.shapes}
                            slotImages={job ? slotImagesFor(job) : undefined}
                          />
                        )}
                      </div>
                      {showTimeSaved && (
                        <div className="text-[10px] text-violet-300/60 mt-0.5">
                          ≈ {humanizeMinutes(minutesSavedForOutput(o.slots_filled, timePrefs))} saved
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-400 tabular-nums hidden sm:table-cell">
                      {o.slots_filled}/{o.slots_total}
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-400 tabular-nums hidden sm:table-cell">
                      {(o.file_size / 1024).toFixed(0)} KB
                    </td>
                    <td className="px-3 py-2 text-right text-neutral-500 hidden md:table-cell">
                      {new Date(o.created_at).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => onDownload(o.id)}
                          className="rounded-md bg-white/90 px-3 py-1 text-xs font-semibold text-neutral-950 hover:bg-white"
                        >
                          Download
                        </button>
                        <button
                          onClick={() => onDelete(o.id)}
                          className="text-xs text-neutral-500 hover:text-rose-400 px-1.5 py-1"
                          title="Delete"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
