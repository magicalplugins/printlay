import { ChangeEvent, DragEvent, FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  adminAssignSubscriber,
  adminListSubscribers,
  adminSetOfficial,
  adminSetPrivateShare,
  adminUnassignSubscriber,
  Asset,
  bulkDeleteAssets,
  Category,
  CatalogueSubscriber,
  createCategory,
  deleteAsset,
  deleteCategory,
  exportCategory,
  importCategory,
  listAssets,
  listCategories,
  listOfficialCatalogues,
  renameCategory,
  subscribeToCatalogue,
  unsubscribeFromCatalogue,
  uploadAsset,
} from "../api/catalogue";
import { getAdminUsers } from "../api/admin";
import { useMe } from "../auth/MeProvider";
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import UsageHint from "../components/app/UsageHint";
import { formatApiError, FormattedApiError } from "../utils/apiError";

type ViewMode = "grid" | "list";
const VIEW_MODE_KEY = "printlay.catalogue.viewMode";

function loadViewMode(): ViewMode {
  try {
    const v = window.localStorage.getItem(VIEW_MODE_KEY);
    return v === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatShortDate(iso: string): string {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 86400) return "today";
  if (diff < 86400 * 2) return "yesterday";
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function OfficialBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 text-[9px] uppercase tracking-widest border border-fuchsia-500/30">
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <path
          d="M4 0l1.2 2.5L8 3l-2 2 .5 3L4 6.5 1.5 8 2 5 0 3l2.8-.5z"
          fill="currentColor"
        />
      </svg>
      Official
    </span>
  );
}

function PrivateBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 text-[9px] uppercase tracking-widest border border-sky-500/30">
      Shared
    </span>
  );
}

function ShareModal({
  categoryId,
  categoryName,
  onClose,
}: {
  categoryId: string;
  categoryName: string;
  onClose: () => void;
}) {
  const [subscribers, setSubscribers] = useState<CatalogueSubscriber[]>([]);
  const [searchQ, setSearchQ] = useState("");
  const [searchResults, setSearchResults] = useState<{ id: string; email: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const loadSubs = useCallback(async () => {
    const data = await adminListSubscribers(categoryId);
    setSubscribers(data);
  }, [categoryId]);

  useEffect(() => { loadSubs(); }, [loadSubs]);

  useEffect(() => {
    if (!searchQ.trim()) { setSearchResults([]); return; }
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await getAdminUsers(searchQ.trim(), 10);
        setSearchResults(
          (res.items || [])
            .filter((u: { id: string }) => !subscribers.find((s) => s.id === u.id))
            .map((u: { id: string; email: string }) => ({ id: u.id, email: u.email }))
        );
      } catch { setSearchResults([]); }
      setSearching(false);
    }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchQ, subscribers]);

  async function onAssign(userId: string) {
    setBusy(true);
    try {
      await adminAssignSubscriber(categoryId, userId);
      await loadSubs();
      setSearchQ("");
      setSearchResults([]);
    } catch { /* ignore */ }
    setBusy(false);
  }

  async function onRemove(userId: string) {
    setBusy(true);
    try {
      await adminUnassignSubscriber(categoryId, userId);
      await loadSubs();
    } catch { /* ignore */ }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-1">Share "{categoryName}"</h3>
        <p className="text-sm text-neutral-400 mb-4">Add or remove users who can access this private catalogue.</p>

        <input
          type="text"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          placeholder="Search users by email..."
          className="w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-sky-500 mb-2"
        />

        {searching && <p className="text-xs text-neutral-500 mb-2">Searching...</p>}

        {searchResults.length > 0 && (
          <div className="max-h-32 overflow-y-auto rounded-lg border border-neutral-700 mb-4">
            {searchResults.map((u) => (
              <div key={u.id} className="flex items-center justify-between px-3 py-2 hover:bg-neutral-800">
                <span className="text-sm text-neutral-200 truncate">{u.email}</span>
                <button
                  onClick={() => onAssign(u.id)}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40"
                >
                  Add
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="mt-2">
          <p className="text-xs uppercase tracking-wider text-neutral-500 mb-2">Shared with ({subscribers.length})</p>
          {subscribers.length === 0 && <p className="text-sm text-neutral-500">No users assigned yet.</p>}
          <div className="max-h-48 overflow-y-auto space-y-1">
            {subscribers.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg bg-neutral-800 px-3 py-2">
                <span className="text-sm text-neutral-200 truncate">{s.email}</span>
                <button
                  onClick={() => onRemove(s.id)}
                  disabled={busy}
                  className="text-xs px-2 py-1 rounded bg-rose-600/80 text-white hover:bg-rose-500 disabled:opacity-40"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Catalogue() {
  const { me } = useMe();
  const isAdmin = !!me?.is_admin;
  const navigate = useNavigate();

  const [cats, setCats] = useState<Category[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));

  // Asset search filter
  const [assetSearch, setAssetSearch] = useState("");

  // Inline rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Browse-officials drawer
  const [browseOpen, setBrowseOpen] = useState(false);
  const [officials, setOfficials] = useState<Category[] | null>(null);
  const [officialsBusy, setOfficialsBusy] = useState(false);

  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  // View mode + bulk selection state
  const [viewMode, setViewMode] = useState<ViewMode>(loadViewMode);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmBulkOpen, setConfirmBulkOpen] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  // Anchor for shift-click range selection in list view.
  const lastSelectedRef = useRef<string | null>(null);

  // Private share modal
  const [shareModalOpen, setShareModalOpen] = useState(false);

  useEffect(() => {
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, viewMode);
    } catch {
      /* noop */
    }
  }, [viewMode]);

  // Selection is per-category; clear when switching categories so a
  // forgotten selection can't be carried into a bulk delete on the
  // wrong catalogue.
  useEffect(() => {
    setSelectedIds(new Set());
    lastSelectedRef.current = null;
  }, [active]);

  // Without a global preventDefault, dropping a file *outside* the dropzone
  // makes the browser navigate to it (image opens in a new tab). Capture
  // every dragover/drop on window so the only thing that ever fires the
  // file is our intentional handler below.
  useEffect(() => {
    const preventNav = (e: globalThis.DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
    };
  }, []);

  const activeCat = useMemo(
    () => cats?.find((c) => c.id === active) ?? null,
    [cats, active]
  );
  const isReadOnly = !!(activeCat?.is_official || activeCat?.is_private_share) && !isAdmin;

  const filteredAssets = useMemo(() => {
    if (!assets) return null;
    const q = assetSearch.trim().toLowerCase();
    if (!q) return assets;
    const words = q.split(/\s+/);
    return assets.filter((a) => {
      const name = a.name.toLowerCase();
      return words.every((w) => name.includes(w));
    });
  }, [assets, assetSearch]);

  async function loadCats() {
    const c = await listCategories();
    setCats(c);
    if (!active && c.length > 0) setActive(c[0].id);
  }

  useEffect(() => {
    loadCats().catch(reportErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    setAssetSearch("");
    listAssets(active).then(setAssets).catch(reportErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function openBrowse() {
    setBrowseOpen(true);
    if (officials !== null) return;
    setOfficialsBusy(true);
    try {
      setOfficials(await listOfficialCatalogues());
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function refreshOfficials() {
    try {
      setOfficials(await listOfficialCatalogues());
    } catch (e) {
      reportErr(e);
    }
  }

  async function onSubscribe(catId: string) {
    setOfficialsBusy(true);
    try {
      await subscribeToCatalogue(catId);
      await Promise.all([refreshOfficials(), loadCats()]);
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function onUnsubscribe(catId: string) {
    if (!confirm("Remove this catalogue from your library?")) return;
    setOfficialsBusy(true);
    try {
      await unsubscribeFromCatalogue(catId);
      if (active === catId) {
        setActive(null);
        setAssets(null);
      }
      await Promise.all([refreshOfficials(), loadCats()]);
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function onCreateCat(e: FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const c = await createCategory(newCatName.trim());
    setNewCatName("");
    setActive(c.id);
    loadCats();
  }

  async function onDeleteCat(id: string) {
    const c = cats?.find((x) => x.id === id);
    if ((c?.is_official || c?.is_private_share) && !isAdmin) {
      await onUnsubscribe(id);
      return;
    }
    if (!confirm("Delete this category and ALL its assets?")) return;
    await deleteCategory(id);
    if (active === id) setActive(null);
    setAssets(null);
    loadCats();
  }

  function startRename(c: Category) {
    // Subscribers can't rename official categories they don't own
    if ((c.is_official || c.is_private_share) && !isAdmin) return;
    setRenamingId(c.id);
    setRenameValue(c.name);
    setTimeout(() => renameInputRef.current?.select(), 0);
  }

  async function commitRename() {
    if (!renamingId) return;
    const trimmed = renameValue.trim();
    if (trimmed) {
      try {
        await renameCategory(renamingId, trimmed);
        await loadCats();
      } catch (e) {
        reportErr(e);
      }
    }
    setRenamingId(null);
  }

  function onRenameKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); void commitRename(); }
    if (e.key === "Escape") setRenamingId(null);
  }

  const ACCEPTED = /\.(pdf|svg|png|jpe?g)$/i;

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || !active || isReadOnly) return;
    const valid = files.filter(
      (f) =>
        ACCEPTED.test(f.name) ||
        /^(application\/pdf|image\/(svg\+xml|png|jpeg))$/.test(f.type)
    );
    const skipped = files.length - valid.length;
    if (valid.length === 0) {
      setErr({
        message: `Only PDF, SVG, PNG, or JPG files are accepted (${skipped} ignored).`,
        suggestsUpgrade: false,
      });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      for (const f of valid) {
        await uploadAsset(active, f, f.name);
      }
      const refreshed = await listAssets(active);
      setAssets(refreshed);
      if (skipped > 0) {
        setErr({
          message: `Uploaded ${valid.length} file${valid.length === 1 ? "" : "s"}; skipped ${skipped} unsupported file${skipped === 1 ? "" : "s"}.`,
          suggestsUpgrade: false,
        });
      }
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(files);
  }

  function onDropFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    if (!active || isReadOnly) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    void uploadFiles(files);
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!active || isReadOnly) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!active || isReadOnly) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  async function onDeleteAsset(id: string) {
    if (isReadOnly) return;
    if (!confirm("Delete this asset?")) return;
    await deleteAsset(id);
    if (active) setAssets(await listAssets(active));
    setSelectedIds((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
  }

  /* ── Selection model ─────────────────────────────────────────────
     - clickAsset toggles a single row.
     - shiftClickAsset selects an inclusive range from the last
       anchor to the clicked id (operates on the currently filtered
       list so what you see is what you select).
     - selectAllVisible / deselectAll cover the header checkbox.
     - Selection is cleared whenever the active category changes or
       a bulk delete completes. */

  function clickAsset(id: string, e: React.MouseEvent) {
    if (e.shiftKey && lastSelectedRef.current && filteredAssets) {
      shiftClickAsset(id);
      return;
    }
    setSelectedIds((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    lastSelectedRef.current = id;
  }

  function shiftClickAsset(id: string) {
    if (!filteredAssets) return;
    const anchor = lastSelectedRef.current;
    if (!anchor) {
      clickAsset(id, { shiftKey: false } as React.MouseEvent);
      return;
    }
    const ids = filteredAssets.map((a) => a.id);
    const i = ids.indexOf(anchor);
    const j = ids.indexOf(id);
    if (i === -1 || j === -1) return;
    const [lo, hi] = i < j ? [i, j] : [j, i];
    setSelectedIds((s) => {
      const next = new Set(s);
      for (let k = lo; k <= hi; k++) next.add(ids[k]);
      return next;
    });
    lastSelectedRef.current = id;
  }

  function selectAllVisible() {
    if (!filteredAssets) return;
    setSelectedIds(new Set(filteredAssets.map((a) => a.id)));
  }

  function deselectAll() {
    setSelectedIds(new Set());
    lastSelectedRef.current = null;
  }

  async function onConfirmBulkDelete() {
    if (selectedIds.size === 0 || isReadOnly) return;
    setBulkBusy(true);
    try {
      await bulkDeleteAssets(Array.from(selectedIds));
      if (active) setAssets(await listAssets(active));
      deselectAll();
      setConfirmBulkOpen(false);
    } catch (e) {
      reportErr(e);
    } finally {
      setBulkBusy(false);
    }
  }

  async function onExport(id: string) {
    setBusy(true);
    setErr(null);
    try {
      const blob = await exportCategory(id);
      const url = URL.createObjectURL(blob);
      const cat = cats?.find((c) => c.id === id);
      const safe = (cat?.name || "category").replace(/[^a-z0-9_-]+/gi, "_");
      const a = document.createElement("a");
      a.href = url;
      a.download = `printlay-${safe}.printlay.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setBusy(true);
    setErr(null);
    try {
      const cat = await importCategory(file);
      await loadCats();
      setActive(cat.id);
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleOfficial() {
    if (!isAdmin || !activeCat || activeCat.is_official === undefined) return;
    setBusy(true);
    try {
      await adminSetOfficial(activeCat.id, !activeCat.is_official);
      await loadCats();
      setOfficials(null);
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function onTogglePrivateShare() {
    if (!isAdmin || !activeCat) return;
    setBusy(true);
    try {
      await adminSetPrivateShare(activeCat.id, !activeCat.is_private_share);
      await loadCats();
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">Catalogue</h1>
            <UsageHint metric="storage" />
            <UsageHint metric="categories" />
          </div>
          <p className="text-neutral-400 mt-1">
            Upload PDFs, SVGs, PNGs, or JPGs. Group them into categories.
            Pull them into jobs by name.
          </p>
        </div>
        <button
          onClick={openBrowse}
          className="inline-flex items-center gap-2 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-4 py-2 text-sm text-fuchsia-200 hover:bg-fuchsia-500/15"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path
              d="M7 0l1.7 4.3 4.6.4-3.5 3 1 4.5L7 9.9 3.2 12.2l1-4.5L.7 4.7l4.6-.4z"
              fill="currentColor"
            />
          </svg>
          Browse official catalogues
        </button>
      </div>

      {err && (
        <div className="mb-4">
          <QuotaErrorBanner error={err} />
        </div>
      )}

      <div className="grid lg:grid-cols-[260px_1fr] gap-6">
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
            Categories
          </div>
          <div className="space-y-1">
            {cats?.map((c) => (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 cursor-pointer ${
                  active === c.id
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
                onClick={() => { if (renamingId !== c.id) setActive(c.id); }}
              >
                {renamingId === c.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={onRenameKey}
                    onClick={(e) => e.stopPropagation()}
                    className="flex-1 min-w-0 rounded border border-neutral-600 bg-neutral-700 px-2 py-0.5 text-sm text-white outline-none focus:border-neutral-400"
                    autoFocus
                  />
                ) : (
                  <span
                    className="flex items-center gap-2 min-w-0"
                    onDoubleClick={(e) => { e.stopPropagation(); startRename(c); }}
                    title={(!c.is_official || isAdmin) ? "Double-click to rename" : undefined}
                  >
                    <span className="truncate">{c.name}</span>
                    {c.is_official && <OfficialBadge />}
                    {c.is_private_share && !c.is_official && <PrivateBadge />}
                  </span>
                )}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCat(c.id);
                  }}
                  className="shrink-0 text-xs text-neutral-500 hover:text-rose-400"
                  title={
                    (c.is_official || c.is_private_share) && !isAdmin
                      ? "Unsubscribe from this catalogue"
                      : "Delete category"
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <form onSubmit={onCreateCat} className="flex gap-2 pt-3">
            <input
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New category"
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
            >
              +
            </button>
          </form>

          <label className="block w-full rounded-md border border-dashed border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 cursor-pointer">
            {busy ? "Importing…" : "↥ Import .printlay.zip"}
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={onImport}
              className="hidden"
            />
          </label>
        </div>

        <div>
          {active ? (
            <>
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="text-sm text-neutral-400 flex items-center gap-2">
                  {activeCat?.is_official && <OfficialBadge />}
                  {assets?.length ?? 0} assets
                  {isReadOnly && (
                    <span className="text-xs text-neutral-500">
                      · read-only (subscribed catalogue)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Grid / list view toggle. Persisted to localStorage so
                      a power-user who lives in list view doesn't have to
                      flip it every visit. */}
                  <div
                    role="group"
                    aria-label="View mode"
                    className="inline-flex rounded-lg border border-neutral-800 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() => setViewMode("grid")}
                      title="Grid view"
                      className={`px-2.5 h-9 text-sm flex items-center ${
                        viewMode === "grid"
                          ? "bg-neutral-800 text-white"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                        <rect x="1" y="1" width="5" height="5" rx="1" fill="currentColor" />
                        <rect x="8" y="1" width="5" height="5" rx="1" fill="currentColor" />
                        <rect x="1" y="8" width="5" height="5" rx="1" fill="currentColor" />
                        <rect x="8" y="8" width="5" height="5" rx="1" fill="currentColor" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewMode("list")}
                      title="List view"
                      className={`px-2.5 h-9 text-sm flex items-center border-l border-neutral-800 ${
                        viewMode === "list"
                          ? "bg-neutral-800 text-white"
                          : "text-neutral-400 hover:text-neutral-200"
                      }`}
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                        <rect x="1" y="2" width="12" height="2" rx="0.5" fill="currentColor" />
                        <rect x="1" y="6" width="12" height="2" rx="0.5" fill="currentColor" />
                        <rect x="1" y="10" width="12" height="2" rx="0.5" fill="currentColor" />
                      </svg>
                    </button>
                  </div>
                  {isAdmin && activeCat && (
                    <button
                      onClick={onToggleOfficial}
                      disabled={busy}
                      className={`rounded-lg border px-3 py-2 text-sm transition ${
                        activeCat.is_official
                          ? "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/15"
                          : "border-neutral-700 text-neutral-200 hover:border-fuchsia-400 hover:text-fuchsia-200"
                      }`}
                      title={
                        activeCat.is_official
                          ? "Unmark - hide from Browse drawer for everyone"
                          : "Mark as Official - users can subscribe to it"
                      }
                    >
                      {activeCat.is_official
                        ? "★ Marked Official"
                        : "☆ Mark as Official"}
                    </button>
                  )}
                  {isAdmin && activeCat && !activeCat.is_official && (
                    <button
                      onClick={onTogglePrivateShare}
                      disabled={busy}
                      className={`rounded-lg border px-3 py-2 text-sm transition ${
                        activeCat.is_private_share
                          ? "border-sky-500/50 bg-sky-500/10 text-sky-200 hover:bg-sky-500/15"
                          : "border-neutral-700 text-neutral-200 hover:border-sky-400 hover:text-sky-200"
                      }`}
                      title={
                        activeCat.is_private_share
                          ? "Remove private share — assigned users will lose access"
                          : "Enable private sharing — assign specific users in Admin > Users"
                      }
                    >
                      {activeCat.is_private_share
                        ? "🔒 Private Share"
                        : "🔗 Share Privately"}
                    </button>
                  )}
                  {isAdmin && activeCat?.is_private_share && (
                    <button
                      onClick={() => setShareModalOpen(true)}
                      className="rounded-lg border border-sky-500/50 px-3 py-2 text-sm text-sky-200 hover:bg-sky-500/10"
                    >
                      Manage Access
                    </button>
                  )}
                  <button
                    onClick={() => onExport(active)}
                    disabled={busy || (assets?.length ?? 0) === 0}
                    className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
                    title="Download a .printlay.zip bundle of this category"
                  >
                    ↧ Export
                  </button>
                  {!isReadOnly && (
                    <label className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 cursor-pointer">
                      {busy ? "Uploading…" : "+ Add files"}
                      <input
                        type="file"
                        accept=".pdf,.svg,.png,.jpg,.jpeg,application/pdf,image/svg+xml,image/png,image/jpeg"
                        multiple
                        onChange={onUpload}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>

              {/* Search within category */}
              {assets && assets.length > 5 && (
                <div className="mb-3">
                  <input
                    type="text"
                    value={assetSearch}
                    onChange={(e) => setAssetSearch(e.target.value)}
                    placeholder="Search assets by name…"
                    className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600 placeholder:text-neutral-500"
                  />
                </div>
              )}

              <div
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDropFiles}
                className={`relative rounded-2xl transition ${
                  dragOver && !isReadOnly
                    ? "ring-2 ring-fuchsia-400/70 bg-fuchsia-500/5"
                    : ""
                } ${selectedIds.size > 0 ? "pb-20" : ""}`}
              >
                {filteredAssets && filteredAssets.length > 0 ? (
                  viewMode === "grid" ? (
                    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                      {filteredAssets.map((a) => {
                        const selected = selectedIds.has(a.id);
                        return (
                          <div
                            key={a.id}
                            onClick={
                              isReadOnly
                                ? undefined
                                : (e) => clickAsset(a.id, e)
                            }
                            className={`group relative aspect-square rounded-lg border bg-white overflow-hidden ring-1 ring-black/5 shadow-sm transition ${
                              selected
                                ? "border-fuchsia-400 ring-fuchsia-400/50"
                                : "border-neutral-800"
                            } ${isReadOnly ? "" : "cursor-pointer"}`}
                          >
                            {a.preview_url || a.thumbnail_url ? (
                              <img
                                src={a.preview_url ?? a.thumbnail_url ?? ""}
                                alt={a.name}
                                className="w-full h-full object-contain p-1 pointer-events-none"
                                draggable={false}
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center text-xs text-neutral-400 uppercase">
                                {a.kind}
                              </div>
                            )}
                            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-xs text-neutral-200 opacity-0 group-hover:opacity-100 transition pointer-events-none">
                              <div className="truncate">{a.name}</div>
                            </div>
                            {!isReadOnly && (
                              <>
                                {/* Selection tick — always visible if
                                    selected so the user can scan a big
                                    grid quickly without hovering. */}
                                <div
                                  className={`absolute top-1.5 left-1.5 h-5 w-5 rounded-md border flex items-center justify-center transition ${
                                    selected
                                      ? "bg-fuchsia-500 border-fuchsia-400"
                                      : "bg-black/60 border-white/30 opacity-0 group-hover:opacity-100"
                                  }`}
                                >
                                  {selected && (
                                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
                                      <path
                                        d="M1.5 5.5L4 8l4.5-5.5"
                                        stroke="white"
                                        strokeWidth="1.6"
                                        fill="none"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      />
                                    </svg>
                                  )}
                                </div>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void onDeleteAsset(a.id);
                                  }}
                                  className="absolute top-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 hover:bg-rose-600"
                                >
                                  ✕
                                </button>
                                {a.is_sticker_editable && (
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigate(`/app/templates/new/sticker?asset=${a.id}`);
                                    }}
                                    className="absolute top-1 right-8 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 hover:bg-fuchsia-600"
                                    title="Edit sticker"
                                  >
                                    ✎
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <AssetListView
                      assets={filteredAssets}
                      selectedIds={selectedIds}
                      onClickAsset={clickAsset}
                      onSelectAll={selectAllVisible}
                      onDeselectAll={deselectAll}
                      onDeleteSingle={onDeleteAsset}
                      onEditSticker={(id) => navigate(`/app/templates/new/sticker?asset=${id}`)}
                      readOnly={isReadOnly}
                    />
                  )
                ) : (
                  <div
                    className={`rounded-2xl border border-dashed p-12 text-center transition ${
                      dragOver && !isReadOnly
                        ? "border-fuchsia-400 text-fuchsia-200"
                        : "border-neutral-800 text-neutral-500"
                    }`}
                  >
                    {assetSearch.trim()
                      ? `No assets matching "${assetSearch.trim()}"`
                      : isReadOnly
                      ? "This official catalogue is empty."
                      : "Drag files here, or click + Add files. PDFs, SVGs, PNGs, JPGs."}
                  </div>
                )}

                {dragOver && !isReadOnly && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-fuchsia-400 bg-neutral-950/70 backdrop-blur-sm">
                    <div className="text-fuchsia-200 font-medium text-sm">
                      Drop to upload to <span className="font-semibold">{activeCat?.name}</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Floating selection / bulk-action bar. Sits at the
                  bottom of the viewport when any asset is selected so
                  the destructive action is always one click away —
                  without ever being on screen by accident. */}
              {!isReadOnly && selectedIds.size > 0 && (
                <div className="fixed left-1/2 bottom-6 z-30 -translate-x-1/2 max-w-[calc(100vw-2rem)]">
                  <div className="flex items-center gap-3 rounded-full border border-neutral-700 bg-neutral-950/95 backdrop-blur px-3 py-2 shadow-2xl">
                    <div className="px-2 text-sm">
                      <span className="font-semibold text-white tabular-nums">
                        {selectedIds.size}
                      </span>{" "}
                      <span className="text-neutral-400">
                        selected
                        {filteredAssets &&
                          filteredAssets.length !== selectedIds.size && (
                            <>
                              {" of "}
                              {filteredAssets.length}
                            </>
                          )}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={selectAllVisible}
                      className="rounded-full px-3 h-8 text-xs font-medium text-neutral-300 hover:bg-neutral-900"
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      onClick={deselectAll}
                      className="rounded-full px-3 h-8 text-xs font-medium text-neutral-300 hover:bg-neutral-900"
                    >
                      Deselect
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmBulkOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-full bg-rose-500 hover:bg-rose-400 px-4 h-8 text-xs font-semibold text-white"
                    >
                      <svg width="11" height="11" viewBox="0 0 11 11" aria-hidden>
                        <path
                          d="M2 3h7l-.6 7H2.6L2 3zm1.5-2h4l.5 1h2v1H1V2h2l.5-1z"
                          fill="currentColor"
                        />
                      </svg>
                      Delete selected
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="text-neutral-500">
              Create a category, or browse official catalogues to subscribe to one.
            </div>
          )}
        </div>
      </div>

      {/* 2-step bulk-delete confirmation. The floating action bar opens
          this; nothing actually deletes until the destructive button
          here is clicked, and we surface the count + a brief sample so
          accidental "select-all → delete" doesn't nuke 800 assets
          silently. */}
      {confirmBulkOpen && (
        <ConfirmBulkDelete
          count={selectedIds.size}
          sampleNames={
            (filteredAssets ?? [])
              .filter((a) => selectedIds.has(a.id))
              .slice(0, 5)
              .map((a) => a.name)
          }
          categoryName={activeCat?.name ?? "this category"}
          busy={bulkBusy}
          onCancel={() => setConfirmBulkOpen(false)}
          onConfirm={onConfirmBulkDelete}
        />
      )}

      {/* Browse drawer */}
      {browseOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6"
          onClick={() => setBrowseOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-2xl bg-neutral-950 border border-neutral-800 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-900">
              <div>
                <div className="font-semibold">Official catalogues</div>
                <div className="text-xs text-neutral-500">
                  Curated by the Printlay team. Subscribe to add one to
                  your library; unsubscribe any time.
                </div>
              </div>
              <button
                onClick={() => setBrowseOpen(false)}
                className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {officialsBusy && (
                <div className="text-sm text-neutral-500">Loading…</div>
              )}
              {!officialsBusy && (officials?.length ?? 0) === 0 && (
                <div className="text-sm text-neutral-500 py-8 text-center">
                  No official catalogues available yet.
                  {isAdmin && (
                    <div className="mt-2 text-xs text-neutral-400">
                      Tip: create a category, upload assets, then click
                      "Mark as Official" to publish it here.
                    </div>
                  )}
                </div>
              )}
              {(officials ?? []).map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-neutral-900 bg-neutral-950 px-4 py-3 hover:border-neutral-700"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm flex items-center gap-2">
                      <OfficialBadge />
                      {c.name}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {c.asset_count ?? 0} asset
                      {c.asset_count === 1 ? "" : "s"}
                    </div>
                  </div>
                  {c.subscribed ? (
                    <button
                      onClick={() => onUnsubscribe(c.id)}
                      disabled={officialsBusy}
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15"
                    >
                      ✓ Subscribed
                    </button>
                  ) : (
                    <button
                      onClick={() => onSubscribe(c.id)}
                      disabled={officialsBusy}
                      className="rounded-md bg-fuchsia-500 hover:bg-fuchsia-400 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Subscribe
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {shareModalOpen && activeCat && (
        <ShareModal
          categoryId={activeCat.id}
          categoryName={activeCat.name}
          onClose={() => setShareModalOpen(false)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   AssetListView — denser, sortable-feeling tabular alternative to the
   grid. Made for ploughing through a hundreds-deep category and
   selecting wide ranges with shift-click.

   Selection model matches the grid: clicking a row toggles, shift-click
   on a row extends from the last anchor. The header checkbox is
   tri-state (none / some / all) and acts on the currently filtered
   list.
   ───────────────────────────────────────────────────────────────────── */
function AssetListView({
  assets,
  selectedIds,
  onClickAsset,
  onSelectAll,
  onDeselectAll,
  onDeleteSingle,
  onEditSticker,
  readOnly,
}: {
  assets: Asset[];
  selectedIds: Set<string>;
  onClickAsset: (id: string, e: React.MouseEvent) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onDeleteSingle: (id: string) => Promise<void> | void;
  onEditSticker?: (id: string) => void;
  readOnly: boolean;
}) {
  const allSelected =
    assets.length > 0 && assets.every((a) => selectedIds.has(a.id));
  const someSelected = !allSelected && assets.some((a) => selectedIds.has(a.id));
  const headerRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someSelected;
  }, [someSelected]);

  function toggleAll() {
    if (allSelected || someSelected) onDeselectAll();
    else onSelectAll();
  }

  return (
    <div className="rounded-xl border border-neutral-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
          <tr>
            <th className="w-10 px-3 py-2 text-left">
              {!readOnly && (
                <input
                  ref={headerRef}
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label={
                    allSelected || someSelected
                      ? "Deselect all"
                      : "Select all"
                  }
                  className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-fuchsia-500 focus:ring-fuchsia-500 cursor-pointer"
                />
              )}
            </th>
            <th className="w-14"></th>
            <th className="text-left font-normal px-3 py-2">Name</th>
            <th className="text-left font-normal px-3 py-2 hidden sm:table-cell">
              Type
            </th>
            <th className="text-right font-normal px-3 py-2 hidden md:table-cell">
              Size
            </th>
            <th className="text-right font-normal px-3 py-2 hidden md:table-cell">
              Added
            </th>
            <th className="w-12"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-900">
          {assets.map((a) => {
            const selected = selectedIds.has(a.id);
            return (
              <tr
                key={a.id}
                onClick={
                  readOnly ? undefined : (e) => onClickAsset(a.id, e)
                }
                className={`transition ${
                  selected
                    ? "bg-fuchsia-500/[0.07]"
                    : "hover:bg-neutral-900/40"
                } ${readOnly ? "" : "cursor-pointer"}`}
              >
                <td
                  className="px-3 py-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!readOnly && (
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() =>
                        onClickAsset(a.id, {
                          shiftKey: false,
                        } as React.MouseEvent)
                      }
                      onClick={(e) => {
                        // Shift-click on the checkbox itself should
                        // still trigger range selection.
                        if (e.shiftKey) {
                          e.preventDefault();
                          onClickAsset(a.id, e as React.MouseEvent);
                        }
                      }}
                      className="h-4 w-4 rounded border-neutral-600 bg-neutral-900 text-fuchsia-500 focus:ring-fuchsia-500 cursor-pointer"
                    />
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <div className="h-10 w-10 rounded border border-neutral-800 bg-white overflow-hidden">
                    {a.preview_url || a.thumbnail_url ? (
                      <img
                        src={a.preview_url ?? a.thumbnail_url ?? ""}
                        alt=""
                        className="w-full h-full object-contain p-0.5"
                        draggable={false}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[9px] text-neutral-500 uppercase">
                        {a.kind}
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-neutral-200 truncate max-w-[420px]">
                  {a.name}
                </td>
                <td className="px-3 py-2 text-neutral-400 uppercase text-xs hidden sm:table-cell">
                  {a.kind}
                </td>
                <td className="px-3 py-2 text-right text-neutral-400 tabular-nums hidden md:table-cell">
                  {formatBytes(a.file_size)}
                </td>
                <td className="px-3 py-2 text-right text-neutral-400 hidden md:table-cell">
                  {formatShortDate(a.created_at)}
                </td>
                <td
                  className="px-3 py-2 text-right"
                  onClick={(e) => e.stopPropagation()}
                >
                  {!readOnly && (
                    <span className="inline-flex items-center gap-2">
                      {a.is_sticker_editable && onEditSticker && (
                        <button
                          type="button"
                          onClick={() => onEditSticker(a.id)}
                          className="text-xs text-neutral-500 hover:text-fuchsia-400"
                          title="Edit sticker"
                        >
                          ✎
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => void onDeleteSingle(a.id)}
                        className="text-xs text-neutral-500 hover:text-rose-400"
                        title="Delete this asset"
                      >
                        ✕
                      </button>
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   ConfirmBulkDelete — second of the two-step deletion flow. Mirrors the
   visual language of the in-app modals (dark panel, rose-accented
   destructive button, escape/click-outside dismiss).
   ───────────────────────────────────────────────────────────────────── */
function ConfirmBulkDelete({
  count,
  sampleNames,
  categoryName,
  busy,
  onCancel,
  onConfirm,
}: {
  count: number;
  sampleNames: string[];
  categoryName: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // Escape to cancel. Body scroll-lock is shared with the browse
  // drawer — both use the same fixed-overlay pattern.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={busy ? undefined : onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-2xl border border-rose-500/30 bg-neutral-950 shadow-2xl overflow-hidden"
      >
        <div className="px-5 pt-5 pb-4 border-b border-neutral-900">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-full bg-rose-500/15 border border-rose-500/30 flex items-center justify-center text-rose-300 shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M8 1l7 13H1L8 1z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 6v3"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                />
                <circle cx="8" cy="11" r="0.6" fill="currentColor" />
              </svg>
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-neutral-100">
                Delete {count} asset{count === 1 ? "" : "s"}?
              </h2>
              <p className="text-xs text-neutral-400 mt-1 leading-relaxed">
                This permanently removes the selected file
                {count === 1 ? "" : "s"} from{" "}
                <span className="text-neutral-200">{categoryName}</span>.
                Templates that reference{" "}
                {count === 1 ? "it" : "them"} will lose those assets and
                show empty slots on their next preview.
              </p>
            </div>
          </div>
        </div>

        {sampleNames.length > 0 && (
          <div className="px-5 py-3 bg-neutral-950/80 max-h-40 overflow-y-auto">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              {count > sampleNames.length
                ? `First ${sampleNames.length} of ${count}`
                : "Selected"}
            </div>
            <ul className="text-xs text-neutral-300 space-y-0.5">
              {sampleNames.map((n) => (
                <li key={n} className="truncate">
                  · {n}
                </li>
              ))}
              {count > sampleNames.length && (
                <li className="text-neutral-500">
                  … and {count - sampleNames.length} more
                </li>
              )}
            </ul>
          </div>
        )}

        <div className="px-5 py-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-lg border border-neutral-700 px-4 h-10 text-sm font-medium text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            autoFocus
            className="inline-flex items-center gap-2 rounded-lg bg-rose-500 hover:bg-rose-400 px-4 h-10 text-sm font-semibold text-white disabled:opacity-50"
          >
            {busy
              ? "Deleting…"
              : `Delete ${count} asset${count === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
