import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  AdminCatalogueItem,
  adminAssignSubscriber,
  adminDeleteCatalogue,
  adminListSubscribers,
  adminSetOfficial,
  adminSetPrivateShare,
  adminUnassignSubscriber,
  CatalogueSubscriber,
  getAdminCatalogues,
} from "../api/catalogue";
import { getAdminUsers } from "../api/admin";

type Filter = "all" | "official" | "private" | "user";
type Sort = "newest" | "assets" | "name";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "official", label: "Official" },
  { id: "private", label: "Private Share" },
  { id: "user", label: "User-uploaded" },
];

const SORTS: { id: Sort; label: string }[] = [
  { id: "newest", label: "Newest" },
  { id: "assets", label: "Most assets" },
  { id: "name", label: "A–Z" },
];

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
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
    } catch (e: any) {
      alert(e?.body?.detail || e?.message || "Failed to assign user");
    }
    setBusy(false);
  }

  async function onRemove(userId: string) {
    setBusy(true);
    try {
      await adminUnassignSubscriber(categoryId, userId);
      await loadSubs();
    } catch (e: any) {
      alert(e?.body?.detail || e?.message || "Failed to remove user");
    }
    setBusy(false);
  }

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl w-full max-w-md p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-semibold mb-1">Share "{categoryName}"</h3>
        <p className="text-sm text-neutral-400 mb-4">Add or remove users who can access this catalogue.</p>
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
                <button onClick={() => onAssign(u.id)} disabled={busy} className="text-xs px-2 py-1 rounded bg-sky-600 text-white hover:bg-sky-500 disabled:opacity-40">Add</button>
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
                <button onClick={() => onRemove(s.id)} disabled={busy} className="text-xs px-2 py-1 rounded bg-rose-600/80 text-white hover:bg-rose-500 disabled:opacity-40">Remove</button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-5 flex justify-end">
          <button onClick={onClose} className="rounded-lg border border-neutral-600 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-800">Done</button>
        </div>
      </div>
    </div>
  );
}

export default function AdminCatalogues() {
  const [items, setItems] = useState<AdminCatalogueItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("newest");
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shareTarget, setShareTarget] = useState<{ id: string; name: string } | null>(null);
  const limit = 30;
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAdminCatalogues({
        q: q || undefined,
        filter: filter === "all" ? undefined : filter,
        sort,
        limit,
        offset,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch {
      setItems([]);
    }
    setLoading(false);
  }, [q, filter, sort, offset]);

  useEffect(() => { load(); }, [load]);

  function onSearchChange(val: string) {
    setQ(val);
    setOffset(0);
  }

  function debouncedSearch(val: string) {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearchChange(val), 300);
  }

  async function onToggleOfficial(item: AdminCatalogueItem) {
    try {
      await adminSetOfficial(item.id, !item.is_official);
      load();
    } catch (e: any) {
      alert(e?.body?.detail || e?.message || "Failed");
    }
  }

  async function onTogglePrivateShare(item: AdminCatalogueItem) {
    try {
      await adminSetPrivateShare(item.id, !item.is_private_share);
      load();
    } catch (e: any) {
      alert(e?.body?.detail || e?.message || "Failed");
    }
  }

  async function onDelete(item: AdminCatalogueItem) {
    if (!confirm(`Delete "${item.name}" (${item.asset_count} assets) permanently?`)) return;
    try {
      await adminDeleteCatalogue(item.id);
      load();
    } catch (e: any) {
      alert(e?.body?.detail || e?.message || "Failed");
    }
  }

  const pages = Math.ceil(total / limit);
  const currentPage = Math.floor(offset / limit) + 1;

  return (
    <div className="max-w-7xl mx-auto px-6 py-12">
      <div className="mb-8">
        <Link to="/app/admin" className="text-sm text-neutral-500 hover:text-neutral-300 mb-2 inline-block">← Admin</Link>
        <h1 className="text-3xl font-bold tracking-tight">All Catalogues</h1>
        <p className="text-sm text-neutral-400 mt-1">
          {total} catalogue{total === 1 ? "" : "s"} across all users
        </p>
      </div>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <input
          type="text"
          defaultValue={q}
          onChange={(e) => debouncedSearch(e.target.value)}
          placeholder="Search by name or email..."
          className="rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-sm text-white placeholder:text-neutral-500 focus:outline-none focus:border-fuchsia-500 w-64"
        />
        <div className="flex rounded-lg border border-neutral-700 overflow-hidden">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => { setFilter(f.id); setOffset(0); }}
              className={`px-3 py-1.5 text-xs font-medium transition ${
                filter === f.id
                  ? "bg-neutral-700 text-white"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <select
          value={sort}
          onChange={(e) => { setSort(e.target.value as Sort); setOffset(0); }}
          className="rounded-lg bg-neutral-900 border border-neutral-700 px-3 py-2 text-xs text-neutral-300"
        >
          {SORTS.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </div>

      {/* Cards grid */}
      {loading ? (
        <div className="text-neutral-500 py-12 text-center">Loading...</div>
      ) : items.length === 0 ? (
        <div className="text-neutral-500 py-12 text-center">No catalogues found.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <div
              key={item.id}
              className="rounded-xl border border-neutral-800 bg-neutral-950 p-4 flex flex-col gap-3 hover:border-neutral-700 transition"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="font-semibold text-sm truncate">{item.name}</h3>
                  <p className="text-xs text-neutral-500 truncate">{item.owner_email}</p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {item.is_official && (
                    <span className="px-1.5 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 text-[9px] uppercase tracking-widest border border-fuchsia-500/30">Official</span>
                  )}
                  {item.is_private_share && (
                    <span className="px-1.5 py-0.5 rounded-full bg-sky-500/15 text-sky-300 text-[9px] uppercase tracking-widest border border-sky-500/30">Shared</span>
                  )}
                </div>
              </div>

              {/* Thumbnail strip */}
              {item.thumbnails.length > 0 ? (
                <div className="flex gap-1.5">
                  {item.thumbnails.map((url, i) => (
                    <img
                      key={i}
                      src={url}
                      alt=""
                      className="w-12 h-12 rounded-md object-cover bg-neutral-800 border border-neutral-800"
                    />
                  ))}
                  {item.asset_count > 4 && (
                    <button
                      onClick={() => setExpanded(expanded === item.id ? null : item.id)}
                      className="w-12 h-12 rounded-md bg-neutral-800 border border-neutral-700 flex items-center justify-center text-xs text-neutral-400 hover:text-white hover:border-neutral-600"
                    >
                      +{item.asset_count - 4}
                    </button>
                  )}
                </div>
              ) : (
                <div className="h-12 flex items-center text-xs text-neutral-600">No assets</div>
              )}

              {/* Meta row */}
              <div className="flex items-center justify-between text-xs text-neutral-500">
                <span>{item.asset_count} asset{item.asset_count === 1 ? "" : "s"}</span>
                <span>{relativeTime(item.created_at)}</span>
              </div>

              {/* Actions */}
              <div className="flex flex-wrap gap-2 pt-1 border-t border-neutral-900">
                <button
                  onClick={() => onToggleOfficial(item)}
                  className={`text-xs px-2 py-1 rounded border transition ${
                    item.is_official
                      ? "border-fuchsia-500/40 text-fuchsia-300 hover:bg-fuchsia-500/10"
                      : "border-neutral-700 text-neutral-400 hover:text-fuchsia-300 hover:border-fuchsia-500/40"
                  }`}
                >
                  {item.is_official ? "★ Official" : "☆ Official"}
                </button>
                {!item.is_official && (
                  <button
                    onClick={() => onTogglePrivateShare(item)}
                    className={`text-xs px-2 py-1 rounded border transition ${
                      item.is_private_share
                        ? "border-sky-500/40 text-sky-300 hover:bg-sky-500/10"
                        : "border-neutral-700 text-neutral-400 hover:text-sky-300 hover:border-sky-500/40"
                    }`}
                  >
                    {item.is_private_share ? "🔒 Private" : "🔗 Private"}
                  </button>
                )}
                {(item.is_official || item.is_private_share) && (
                  <button
                    onClick={() => setShareTarget({ id: item.id, name: item.name })}
                    className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-sky-300 hover:border-sky-500/40 transition"
                  >
                    Manage Access
                  </button>
                )}
                <button
                  onClick={() => onDelete(item)}
                  className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-400 hover:text-rose-400 hover:border-rose-500/40 transition ml-auto"
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-3 mt-8">
          <button
            onClick={() => setOffset(Math.max(0, offset - limit))}
            disabled={offset === 0}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-30 hover:bg-neutral-800"
          >
            ← Prev
          </button>
          <span className="text-sm text-neutral-500">
            Page {currentPage} of {pages}
          </span>
          <button
            onClick={() => setOffset(offset + limit)}
            disabled={currentPage >= pages}
            className="rounded-lg border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 disabled:opacity-30 hover:bg-neutral-800"
          >
            Next →
          </button>
        </div>
      )}

      {/* Share modal */}
      {shareTarget && (
        <ShareModal
          categoryId={shareTarget.id}
          categoryName={shareTarget.name}
          onClose={() => setShareTarget(null)}
        />
      )}
    </div>
  );
}
