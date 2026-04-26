import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { deleteTemplate, listTemplates, Template } from "../api/templates";
import { CardGridSkeleton } from "../components/Skeleton";
import { LockedButton } from "../components/app/LockedOverlay";
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import UsageHint from "../components/app/UsageHint";
import { formatApiError, FormattedApiError } from "../utils/apiError";

type View = "grid" | "list";

function GridIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function ListIcon({ active }: { active: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function SourceBadge({ source }: { source: string }) {
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
      source === "uploaded"
        ? "bg-sky-950/60 text-sky-400 border border-sky-800/50"
        : "bg-violet-950/60 text-violet-400 border border-violet-800/50"
    }`}>
      {source === "uploaded" ? "PDF" : "Generated"}
    </span>
  );
}

export default function Templates() {
  const [items, setItems] = useState<Template[] | null>(null);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem("printlay.templatesView") as View) || "grid"; }
    catch { return "grid"; }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  async function load() {
    try {
      const data = await listTemplates();
      setItems(data);
    } catch (e) {
      reportErr(e);
    }
  }

  useEffect(() => { load(); }, []);

  function switchView(v: View) {
    setView(v);
    setSelected(new Set());
    try { localStorage.setItem("printlay.templatesView", v); } catch { /* ok */ }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this template? This cannot be undone.")) return;
    await deleteTemplate(id);
    load();
  }

  async function onDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} template${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => deleteTemplate(id)));
      setSelected(new Set());
      load();
    } catch (e) {
      reportErr(e);
    } finally {
      setDeleting(false);
    }
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
    if (selected.size === items.length) setSelected(new Set());
    else setSelected(new Set(items.map((t) => t.id)));
  }

  const allSelected = !!items && items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4 mb-8">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Templates</h1>
            <UsageHint metric="templates" />
          </div>
          <p className="text-neutral-400 mt-1 text-sm hidden sm:block">
            Upload an Illustrator/PDF, or generate one from artboard + shape spec.
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
              aria-label="Grid view" title="Grid view"
            >
              <GridIcon active={view === "grid"} />
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              type="button"
              onClick={() => switchView("list")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === "list" ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"
              }`}
              aria-label="List view" title="List view"
            >
              <ListIcon active={view === "list"} />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
          <LockedButton>
            <Link
              to="/app/templates/new"
              className="shrink-0 rounded-lg bg-white px-3 sm:px-4 py-2 sm:py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
            >
              <span className="sm:hidden">+ New</span>
              <span className="hidden sm:inline">+ New template</span>
            </Link>
          </LockedButton>
        </div>
      </div>

      {err && (
        <div className="mb-4">
          <QuotaErrorBanner error={err} />
        </div>
      )}

      {items === null ? (
        <CardGridSkeleton />
      ) : items.length === 0 ? (
        <Empty />
      ) : view === "grid" ? (
        /* ── GRID VIEW ─────────────────────────────────────────────── */
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((t) => (
            <div
              key={t.id}
              className="group rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-3 hover:border-neutral-700 transition"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="font-semibold truncate">{t.name}</div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <SourceBadge source={t.source} />
                    <span className="text-xs text-neutral-500">{t.shapes.length} slots</span>
                    <span className="text-xs text-neutral-600">·</span>
                    {t.has_ocg ? (
                      <span className="text-xs text-emerald-400">POSITIONS ✓</span>
                    ) : (
                      <span className="text-xs text-amber-400">no layer</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500">
                    {Math.round((t.page_width * 25.4) / 72)} × {Math.round((t.page_height * 25.4) / 72)} mm
                  </div>
                </div>
                <button
                  onClick={() => onDelete(t.id)}
                  className="shrink-0 text-xs text-neutral-500 hover:text-rose-400 px-2 py-1 -mr-2 -mt-1 transition"
                  title="Delete"
                  aria-label={`Delete template ${t.name}`}
                >
                  ✕
                </button>
              </div>
              <div className="flex gap-2 text-xs">
                <Link
                  to={`/app/templates/${t.id}`}
                  className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 transition"
                >
                  Open
                </Link>
                <Link
                  to={`/app/jobs/new?template=${t.id}`}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700 transition"
                >
                  Program slots →
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── LIST VIEW ─────────────────────────────────────────────── */
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          {/* Toolbar */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/60">
            <button
              type="button"
              onClick={toggleAll}
              aria-label={allSelected ? "Deselect all" : "Select all"}
              className="flex items-center justify-center w-5 h-5 rounded border-2 transition shrink-0"
              style={{
                background: allSelected ? "#7c3aed" : someSelected ? "rgba(124,58,237,0.3)" : "transparent",
                borderColor: allSelected || someSelected ? "#7c3aed" : "#525252",
              }}
            >
              {allSelected && (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white"
                  strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2,6 5,9 10,3" />
                </svg>
              )}
              {someSelected && !allSelected && (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white"
                  strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                  <line x1="2.5" y1="6" x2="9.5" y2="6" />
                </svg>
              )}
            </button>

            <span className="text-sm text-neutral-400 flex-1">
              {someSelected
                ? `${selected.size} of ${items.length} selected`
                : `${items.length} template${items.length !== 1 ? "s" : ""}`}
            </span>

            {someSelected && (
              <button
                type="button"
                onClick={onDeleteSelected}
                disabled={deleting}
                className="flex items-center gap-1.5 rounded-lg bg-rose-600/20 border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-400 hover:bg-rose-600/30 hover:border-rose-400/60 transition disabled:opacity-50"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {deleting ? "Deleting…" : `Delete ${selected.size}`}
              </button>
            )}
          </div>

          {/* Rows */}
          {items.map((t, idx) => {
            const isSelected = selected.has(t.id);
            const wMm = Math.round((t.page_width * 25.4) / 72);
            const hMm = Math.round((t.page_height * 25.4) / 72);

            return (
              <div
                key={t.id}
                className={`group flex items-center gap-3 px-4 py-3 transition ${
                  idx < items.length - 1 ? "border-b border-neutral-800/70" : ""
                } ${isSelected ? "bg-violet-950/30" : "hover:bg-neutral-900/60"}`}
              >
                {/* Checkbox */}
                <button
                  type="button"
                  onClick={() => toggleSelect(t.id)}
                  aria-label={isSelected ? `Deselect ${t.name}` : `Select ${t.name}`}
                  className="flex items-center justify-center w-5 h-5 rounded border-2 transition shrink-0"
                  style={{
                    background: isSelected ? "#7c3aed" : "transparent",
                    borderColor: isSelected ? "#7c3aed" : "#525252",
                  }}
                >
                  {isSelected && (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white"
                      strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="2,6 5,9 10,3" />
                    </svg>
                  )}
                </button>

                {/* Info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-sm truncate group-hover:text-white transition">
                      {t.name}
                    </span>
                    <SourceBadge source={t.source} />
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                    <span className="text-xs text-neutral-500">{t.shapes.length} slots</span>
                    <span className="text-xs text-neutral-600">·</span>
                    <span className="text-xs text-neutral-500">{wMm} × {hMm} mm</span>
                    <span className="text-xs text-neutral-600">·</span>
                    {t.has_ocg ? (
                      <span className="text-xs text-emerald-400">POSITIONS ✓</span>
                    ) : (
                      <span className="text-xs text-amber-400">no layer</span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    to={`/app/templates/${t.id}`}
                    className="hidden sm:inline-flex items-center rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs hover:border-neutral-600 transition"
                  >
                    Open
                  </Link>
                  <Link
                    to={`/app/jobs/new?template=${t.id}`}
                    className="inline-flex items-center rounded-md bg-neutral-800 px-2.5 py-1.5 text-xs hover:bg-neutral-700 transition whitespace-nowrap"
                  >
                    Program →
                  </Link>
                  <button
                    type="button"
                    onClick={() => onDelete(t.id)}
                    title="Delete"
                    aria-label={`Delete ${t.name}`}
                    className="rounded-md p-1.5 text-neutral-500 hover:text-rose-400 hover:bg-neutral-800 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
      <div className="text-2xl mb-2">No templates yet</div>
      <p>Start by uploading an AI/PDF or generating a grid.</p>
      <Link
        to="/app/templates/new"
        className="inline-block mt-4 rounded-lg bg-white px-4 py-2 font-semibold text-neutral-950 hover:bg-neutral-200"
      >
        + New template
      </Link>
    </div>
  );
}
