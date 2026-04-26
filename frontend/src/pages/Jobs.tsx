import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteJob, duplicateJob, Job, listJobs, updateJob } from "../api/jobs";
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

export default function Jobs() {
  const [items, setItems] = useState<Job[] | null>(null);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [savingId, setSavingId] = useState<string | null>(null);
  const [view, setView] = useState<View>(() => {
    try { return (localStorage.getItem("printlay.jobsView") as View) || "grid"; }
    catch { return "grid"; }
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  function load() {
    listJobs().then(setItems).catch((e) => reportErr(e));
  }
  useEffect(load, []);

  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  function switchView(v: View) {
    setView(v);
    setSelected(new Set());
    try { localStorage.setItem("printlay.jobsView", v); } catch { /* ok */ }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this job?")) return;
    await deleteJob(id);
    load();
  }

  async function onDeleteSelected() {
    if (selected.size === 0) return;
    if (!confirm(`Delete ${selected.size} job${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await Promise.all([...selected].map((id) => deleteJob(id)));
      setSelected(new Set());
      load();
    } catch (e) {
      reportErr(e);
    } finally {
      setDeleting(false);
    }
  }

  async function onDuplicate(id: string) {
    try {
      const dup = await duplicateJob(id);
      setItems((cur) => (cur ? [dup, ...cur] : [dup]));
      setEditingId(dup.id);
      setEditingName(dup.name);
    } catch (e) {
      reportErr(e);
    }
  }

  function startRename(j: Job) {
    setEditingId(j.id);
    setEditingName(j.name);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingName("");
  }

  async function commitRename(id: string) {
    const next = editingName.trim();
    const current = items?.find((x) => x.id === id);
    if (!current) { cancelRename(); return; }
    if (!next || next === current.name) { cancelRename(); return; }
    setSavingId(id);
    try {
      const updated = await updateJob(id, { name: next });
      setItems((cur) =>
        cur ? cur.map((x) => (x.id === id ? { ...x, name: updated.name } : x)) : cur
      );
      cancelRename();
    } catch (e) {
      reportErr(e);
    } finally {
      setSavingId(null);
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
    if (selected.size === items.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(items.map((j) => j.id)));
    }
  }

  const allSelected = !!items && items.length > 0 && selected.size === items.length;
  const someSelected = selected.size > 0;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      {/* Header */}
      <div className="flex flex-wrap items-start gap-4 mb-8">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Jobs</h1>
            <UsageHint metric="jobs" />
          </div>
          <p className="text-neutral-400 mt-1 text-sm sm:text-base">
            A job = a programmed slot order over a template, plus per-slot fills.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* View toggle */}
          <div className="flex items-center rounded-lg border border-neutral-800 p-0.5 bg-neutral-900/60">
            <button
              type="button"
              onClick={() => switchView("grid")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === "grid"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
              aria-label="Grid view"
              title="Grid view"
            >
              <GridIcon active={view === "grid"} />
              <span className="hidden sm:inline">Grid</span>
            </button>
            <button
              type="button"
              onClick={() => switchView("list")}
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition ${
                view === "list"
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-white"
              }`}
              aria-label="List view"
              title="List view"
            >
              <ListIcon active={view === "list"} />
              <span className="hidden sm:inline">List</span>
            </button>
          </div>
          <LockedButton>
            <Link
              to="/app/templates"
              className="rounded-lg bg-white px-3 sm:px-4 py-2 sm:py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 whitespace-nowrap"
            >
              + New job
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
        <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
          No jobs yet. Open a template and click "Program slots →".
        </div>
      ) : view === "grid" ? (
        /* ── GRID VIEW ─────────────────────────────────────────────── */
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((j) => {
            const filled = Object.keys(j.assignments).length;
            const total = j.slot_order.length;
            const isEditing = editingId === j.id;
            const open = () => { if (isEditing) return; navigate(`/app/jobs/${j.id}/fill`); };
            const stop = (e: React.SyntheticEvent) => e.stopPropagation();
            return (
              <div
                key={j.id}
                onClick={open}
                onKeyDown={(e) => {
                  if (isEditing) return;
                  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
                }}
                role="button"
                tabIndex={isEditing ? -1 : 0}
                aria-label={`Open job ${j.name}`}
                className={`group rounded-xl border p-5 space-y-3 transition focus:outline-none focus-visible:ring-2 focus-visible:ring-violet-500/60 ${
                  isEditing
                    ? "border-violet-500/50 bg-neutral-900/80 cursor-default"
                    : "border-neutral-800 bg-neutral-900/50 cursor-pointer hover:border-violet-500/50 hover:bg-neutral-900/80"
                }`}
                style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    {isEditing ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onClick={stop}
                        onPointerDown={stop}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") { e.preventDefault(); commitRename(j.id); }
                          else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                        }}
                        onBlur={() => commitRename(j.id)}
                        disabled={savingId === j.id}
                        maxLength={120}
                        className="w-full rounded-md border border-violet-500/60 bg-neutral-950 px-2 py-1 font-semibold text-white outline-none ring-2 ring-violet-500/30 focus:ring-violet-500/60 disabled:opacity-60"
                        aria-label="Rename job"
                      />
                    ) : (
                      <div className="flex items-center gap-1.5 min-w-0">
                        <div className="font-semibold truncate group-hover:text-white">{j.name}</div>
                        <button
                          type="button"
                          onClick={(e) => { stop(e); startRename(j); }}
                          className="shrink-0 rounded p-1 text-neutral-500 hover:text-violet-300 hover:bg-neutral-800/80 opacity-0 group-hover:opacity-100 focus:opacity-100 transition"
                          aria-label={`Rename job ${j.name}`}
                          title="Rename"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            <path d="M12 20h9" />
                            <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                          </svg>
                        </button>
                      </div>
                    )}
                    <div className="text-xs text-neutral-500 mt-1">
                      {filled}/{total} slots filled
                      {isEditing && (
                        <span className="ml-2 text-violet-300/80">Press Enter to save · Esc to cancel</span>
                      )}
                    </div>
                  </div>
                  {!isEditing && (
                    <button
                      type="button"
                      onClick={(e) => { stop(e); onDelete(j.id); }}
                      className="shrink-0 text-xs text-neutral-500 hover:text-rose-400 px-2 py-1 -mr-2 -mt-1"
                      aria-label={`Delete job ${j.name}`}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Link
                    to={`/app/jobs/${j.id}/program`}
                    onClick={stop}
                    className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600"
                  >
                    Program
                  </Link>
                  <Link
                    to={`/app/jobs/${j.id}/fill`}
                    onClick={stop}
                    className="rounded-md bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
                  >
                    Fill →
                  </Link>
                  <button
                    type="button"
                    onClick={(e) => { stop(e); startRename(j); }}
                    className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 text-neutral-300 sm:hidden"
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { stop(e); onDuplicate(j.id); }}
                    className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 text-neutral-300"
                  >
                    Duplicate
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* ── LIST VIEW ─────────────────────────────────────────────── */
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          {/* List toolbar */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-neutral-800 bg-neutral-900/60">
            {/* Select-all checkbox */}
            <button
              type="button"
              onClick={toggleAll}
              aria-label={allSelected ? "Deselect all" : "Select all"}
              className="flex items-center justify-center w-5 h-5 rounded border-2 border-neutral-600 hover:border-violet-400 transition shrink-0"
              style={{
                background: allSelected ? "#7c3aed" : someSelected ? "rgba(124,58,237,0.3)" : "transparent",
                borderColor: allSelected || someSelected ? "#7c3aed" : undefined,
              }}
            >
              {allSelected && (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.2"
                  strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2,6 5,9 10,3" />
                </svg>
              )}
              {someSelected && !allSelected && (
                <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.5"
                  strokeLinecap="round" aria-hidden="true">
                  <line x1="2.5" y1="6" x2="9.5" y2="6" />
                </svg>
              )}
            </button>

            <span className="text-sm text-neutral-400 flex-1">
              {someSelected
                ? `${selected.size} of ${items.length} selected`
                : `${items.length} job${items.length !== 1 ? "s" : ""}`}
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
          {items.map((j, idx) => {
            const filled = Object.keys(j.assignments).length;
            const total = j.slot_order.length;
            const isEditing = editingId === j.id;
            const isSelected = selected.has(j.id);
            const stop = (e: React.SyntheticEvent) => e.stopPropagation();
            const pct = total > 0 ? Math.round((filled / total) * 100) : 0;

            return (
              <div
                key={j.id}
                className={`group flex items-center gap-3 px-4 py-3 transition ${
                  idx < items.length - 1 ? "border-b border-neutral-800/70" : ""
                } ${
                  isSelected
                    ? "bg-violet-950/30"
                    : "hover:bg-neutral-900/60"
                }`}
              >
                {/* Checkbox */}
                <button
                  type="button"
                  onClick={() => toggleSelect(j.id)}
                  aria-label={isSelected ? `Deselect ${j.name}` : `Select ${j.name}`}
                  className="flex items-center justify-center w-5 h-5 rounded border-2 transition shrink-0"
                  style={{
                    background: isSelected ? "#7c3aed" : "transparent",
                    borderColor: isSelected ? "#7c3aed" : "#525252",
                  }}
                >
                  {isSelected && (
                    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="white" strokeWidth="2.2"
                      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <polyline points="2,6 5,9 10,3" />
                    </svg>
                  )}
                </button>

                {/* Name + progress */}
                <div
                  className="flex-1 min-w-0 cursor-pointer"
                  onClick={() => { if (!isEditing) navigate(`/app/jobs/${j.id}/fill`); }}
                >
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onClick={stop}
                      onPointerDown={stop}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") { e.preventDefault(); commitRename(j.id); }
                        else if (e.key === "Escape") { e.preventDefault(); cancelRename(); }
                      }}
                      onBlur={() => commitRename(j.id)}
                      disabled={savingId === j.id}
                      maxLength={120}
                      className="w-full rounded-md border border-violet-500/60 bg-neutral-950 px-2 py-1 text-sm font-semibold text-white outline-none ring-2 ring-violet-500/30 focus:ring-violet-500/60 disabled:opacity-60"
                      aria-label="Rename job"
                    />
                  ) : (
                    <div className="font-medium text-sm truncate group-hover:text-white transition">{j.name}</div>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <div className="h-1 flex-1 max-w-[120px] rounded-full bg-neutral-800 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-violet-500 transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-neutral-500 shrink-0">{filled}/{total} slots</span>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  <Link
                    to={`/app/jobs/${j.id}/program`}
                    onClick={stop}
                    className="hidden sm:inline-flex items-center rounded-md border border-neutral-800 px-2.5 py-1.5 text-xs hover:border-neutral-600 transition"
                  >
                    Program
                  </Link>
                  <Link
                    to={`/app/jobs/${j.id}/fill`}
                    onClick={stop}
                    className="inline-flex items-center rounded-md bg-neutral-800 px-2.5 py-1.5 text-xs hover:bg-neutral-700 transition"
                  >
                    Fill →
                  </Link>
                  {/* Rename */}
                  <button
                    type="button"
                    onClick={(e) => { stop(e); startRename(j); }}
                    title="Rename"
                    className="rounded-md p-1.5 text-neutral-500 hover:text-violet-300 hover:bg-neutral-800 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Rename ${j.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 20h9" />
                      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
                    </svg>
                  </button>
                  {/* Duplicate */}
                  <button
                    type="button"
                    onClick={(e) => { stop(e); onDuplicate(j.id); }}
                    title="Duplicate"
                    className="rounded-md p-1.5 text-neutral-500 hover:text-violet-300 hover:bg-neutral-800 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Duplicate ${j.name}`}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <rect x="9" y="9" width="13" height="13" rx="2" />
                      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                  </button>
                  {/* Delete */}
                  <button
                    type="button"
                    onClick={(e) => { stop(e); onDelete(j.id); }}
                    title="Delete"
                    className="rounded-md p-1.5 text-neutral-500 hover:text-rose-400 hover:bg-neutral-800 transition opacity-0 group-hover:opacity-100 focus:opacity-100"
                    aria-label={`Delete ${j.name}`}
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
