import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AdminLead,
  AdminLeadsPage,
  LeadCategory,
  LeadStatus,
  getAdminLeads,
  patchLeadStatus,
} from "../api/admin";

const FILTERS: { key: LeadStatus | "inbox"; label: string }[] = [
  { key: "inbox", label: "Inbox" },
  { key: "new", label: "New" },
  { key: "read", label: "Read" },
  { key: "responded", label: "Responded" },
  { key: "archived", label: "Archived" },
];

const CATEGORY_META: Record<
  LeadCategory,
  { label: string; emoji: string; cls: string }
> = {
  support: {
    label: "Support",
    emoji: "🛠",
    cls: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  },
  presales: {
    label: "Pre-Sales",
    emoji: "💬",
    cls: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
  },
  bug_feature: {
    label: "Bug / Feature",
    emoji: "💡",
    cls: "bg-blue-500/15 text-blue-300 border-blue-500/30",
  },
  general: {
    label: "General",
    emoji: "📨",
    cls: "bg-neutral-700/30 text-neutral-300 border-neutral-700",
  },
};

const CATEGORY_FILTERS: { key: LeadCategory | "all"; label: string; emoji: string }[] = [
  { key: "all", label: "All types", emoji: "📥" },
  { key: "support", label: "Support", emoji: "🛠" },
  { key: "presales", label: "Pre-Sales", emoji: "💬" },
  { key: "bug_feature", label: "Bug / Feature", emoji: "💡" },
  { key: "general", label: "General", emoji: "📨" },
];

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  const diff = (Date.now() - t) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

type DateBucket = "today" | "yesterday" | "thisWeek" | "earlier";

function dateBucket(iso: string): DateBucket {
  const d = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfYesterday = startOfToday - 86400 * 1000;
  const startOfWeek = startOfToday - 86400 * 7 * 1000;
  const t = d.getTime();
  if (t >= startOfToday) return "today";
  if (t >= startOfYesterday) return "yesterday";
  if (t >= startOfWeek) return "thisWeek";
  return "earlier";
}

const BUCKET_LABELS: Record<DateBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "This week",
  earlier: "Earlier",
};

function statusPill(status: LeadStatus) {
  const map: Record<LeadStatus, string> = {
    new: "bg-violet-500/15 text-violet-300 border-violet-500/30",
    read: "bg-neutral-700/30 text-neutral-300 border-neutral-700",
    responded: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    archived: "bg-neutral-800/60 text-neutral-500 border-neutral-800",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${map[status]}`}
    >
      {status}
    </span>
  );
}

function categoryBadge(category: LeadCategory) {
  const meta = CATEGORY_META[category] ?? CATEGORY_META.general;
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${meta.cls}`}
    >
      <span className="text-[10px] leading-none">{meta.emoji}</span>
      {meta.label}
    </span>
  );
}

export default function AdminLeads() {
  const [filter, setFilter] = useState<LeadStatus | "inbox">("inbox");
  const [categoryFilter, setCategoryFilter] = useState<LeadCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<AdminLeadsPage | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await getAdminLeads(
        filter === "inbox" ? undefined : (filter as LeadStatus),
        categoryFilter === "all" ? null : categoryFilter
      );
      setData(res);
      if (!selectedId || !res.items.some((l) => l.id === selectedId)) {
        setSelectedId(res.items[0]?.id ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [filter, categoryFilter, selectedId]);

  useEffect(() => {
    load();
  }, [filter, categoryFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredItems = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    if (!q) return data.items;
    return data.items.filter(
      (l) =>
        l.name.toLowerCase().includes(q) ||
        l.email.toLowerCase().includes(q) ||
        l.message.toLowerCase().includes(q)
    );
  }, [data, query]);

  const grouped = useMemo(() => {
    const buckets: Record<DateBucket, AdminLead[]> = {
      today: [],
      yesterday: [],
      thisWeek: [],
      earlier: [],
    };
    for (const lead of filteredItems) {
      buckets[dateBucket(lead.created_at)].push(lead);
    }
    return buckets;
  }, [filteredItems]);

  const selected: AdminLead | null = useMemo(
    () => data?.items.find((l) => l.id === selectedId) ?? null,
    [data, selectedId]
  );

  // Auto-mark "new" leads as "read" when opened.
  useEffect(() => {
    if (!selected || selected.status !== "new") return;
    let cancelled = false;
    (async () => {
      try {
        const updated = await patchLeadStatus(selected.id, "read");
        if (cancelled) return;
        setData((prev) =>
          prev
            ? {
                ...prev,
                unread: Math.max(0, prev.unread - 1),
                items: prev.items.map((l) =>
                  l.id === updated.id ? updated : l
                ),
              }
            : prev
        );
      } catch {
        // silent
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selected]);

  async function setStatus(id: string, status: LeadStatus) {
    try {
      const updated = await patchLeadStatus(id, status);
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((l) => (l.id === id ? updated : l)),
            }
          : prev
      );
      if (status === "archived" && filter !== "archived") {
        const idx = filteredItems.findIndex((l) => l.id === id);
        const next = filteredItems[idx + 1] ?? filteredItems[idx - 1] ?? null;
        setSelectedId(next?.id ?? null);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const totalShown = filteredItems.length;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="text-xs text-neutral-500 mb-1">
        <Link to="/app/admin" className="hover:text-neutral-300">
          ← Admin
        </Link>
      </div>
      <header className="flex items-end justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Leads</h1>
          <p className="text-neutral-500 text-sm mt-1">
            Inbound messages from the chat widget on the site and inside the
            app.
          </p>
        </div>
        {data && data.unread > 0 && (
          <span className="inline-flex items-center gap-2 rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-xs font-semibold text-violet-200">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-400 animate-pulse" />
            {data.unread} unread
          </span>
        )}
      </header>

      {/* Category filter chips */}
      <div className="flex flex-wrap items-center gap-1.5 mb-3">
        {CATEGORY_FILTERS.map((c) => {
          const count =
            c.key === "all"
              ? (data?.items.length ?? 0)
              : (data?.counts_by_category?.[c.key] ?? 0);
          const active = categoryFilter === c.key;
          return (
            <button
              key={c.key}
              onClick={() => setCategoryFilter(c.key)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border transition ${
                active
                  ? "border-violet-400/60 bg-violet-500/15 text-violet-100"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              }`}
            >
              <span className="text-[11px] leading-none">{c.emoji}</span>
              {c.label}
              {count > 0 && (
                <span
                  className={`tabular-nums text-[10px] ${
                    active ? "text-violet-300" : "text-neutral-500"
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Status filter + search */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full px-3 py-1 text-xs font-medium border transition ${
                filter === f.key
                  ? "border-neutral-100 bg-neutral-100 text-neutral-950"
                  : "border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-neutral-200"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2 flex-1 min-w-[200px] max-w-sm">
          <div className="relative flex-1">
            <svg
              width="14"
              height="14"
              viewBox="0 0 14 14"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
            >
              <circle
                cx="6"
                cy="6"
                r="4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M9 9l3.5 3.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, email or message"
              className="w-full rounded-md border border-neutral-800 bg-neutral-950 pl-8 pr-3 h-8 text-xs outline-none focus:border-violet-500/50 placeholder:text-neutral-600"
            />
          </div>
          <button
            onClick={load}
            className="text-xs text-neutral-400 hover:text-neutral-200"
            title="Refresh"
          >
            ↻
          </button>
        </div>
      </div>

      {err && (
        <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          {err}
        </div>
      )}

      {/* Two-pane layout */}
      <div className="grid grid-cols-1 lg:grid-cols-[380px_1fr] gap-4 min-h-[60vh]">
        {/* List */}
        <div className="rounded-xl border border-neutral-800 overflow-hidden bg-neutral-950/60 flex flex-col">
          {loading && !data ? (
            <div className="px-4 py-8 text-sm text-neutral-500">Loading…</div>
          ) : totalShown === 0 ? (
            <div className="px-4 py-12 text-center">
              <div className="mx-auto h-10 w-10 rounded-full bg-neutral-900 border border-neutral-800 flex items-center justify-center mb-3">
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
                  <path
                    d="M3 4.5a2 2 0 012-2h8a2 2 0 012 2v6a2 2 0 01-2 2H7l-3.5 3v-3H5a2 2 0 01-2-2v-6z"
                    fill="rgb(115, 115, 115)"
                  />
                </svg>
              </div>
              <p className="text-sm text-neutral-400">
                {query
                  ? `No leads match "${query}".`
                  : filter === "inbox" || filter === "new"
                  ? "No new leads yet — they'll show up here when someone uses the chat widget."
                  : `No leads in "${filter}".`}
              </p>
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto">
              {(["today", "yesterday", "thisWeek", "earlier"] as DateBucket[]).map(
                (bucket) => {
                  const items = grouped[bucket];
                  if (items.length === 0) return null;
                  return (
                    <div key={bucket}>
                      <div className="sticky top-0 z-10 bg-neutral-950/95 backdrop-blur px-4 py-1.5 text-[10px] uppercase tracking-widest text-neutral-500 border-b border-neutral-900">
                        {BUCKET_LABELS[bucket]}
                        <span className="ml-2 text-neutral-600 tabular-nums">
                          {items.length}
                        </span>
                      </div>
                      <ul className="divide-y divide-neutral-900">
                        {items.map((l) => {
                          const active = l.id === selectedId;
                          const unread = l.status === "new";
                          return (
                            <li key={l.id}>
                              <button
                                onClick={() => setSelectedId(l.id)}
                                className={`w-full text-left px-4 py-3 transition ${
                                  active
                                    ? "bg-violet-500/10"
                                    : "hover:bg-neutral-900/60"
                                }`}
                              >
                                <div className="flex items-center gap-2 mb-0.5">
                                  {unread && (
                                    <span className="h-2 w-2 rounded-full bg-violet-400 shrink-0" />
                                  )}
                                  <span
                                    className={`text-sm truncate ${
                                      unread
                                        ? "font-semibold text-neutral-100"
                                        : "text-neutral-300"
                                    }`}
                                  >
                                    {l.name}
                                  </span>
                                  <span className="ml-auto text-[10px] text-neutral-500 shrink-0">
                                    {relative(l.created_at)}
                                  </span>
                                </div>
                                <div className="text-xs text-neutral-500 truncate">
                                  {l.email}
                                </div>
                                <div className="mt-1.5 flex items-center gap-1.5 flex-wrap">
                                  {categoryBadge(l.category)}
                                  {l.phone && (
                                    <span
                                      className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
                                      title={`Phone: ${l.phone}`}
                                    >
                                      <svg width="9" height="9" viewBox="0 0 12 12" aria-hidden>
                                        <path
                                          d="M2.5 2.5a1 1 0 011-1h1.2a1 1 0 011 .76l.4 1.6a1 1 0 01-.27 1L5 5.8a7 7 0 003.2 3.2l.94-.84a1 1 0 011-.27l1.6.4a1 1 0 01.76 1V10.5a1 1 0 01-1 1A8 8 0 012.5 3.5z"
                                          fill="currentColor"
                                        />
                                      </svg>
                                      Phone
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 text-xs text-neutral-400 line-clamp-2">
                                  {l.message}
                                </div>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  );
                }
              )}
            </div>
          )}
        </div>

        {/* Detail pane */}
        <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-6">
          {!selected ? (
            <div className="h-full flex items-center justify-center text-sm text-neutral-500">
              Select a lead to view the full message.
            </div>
          ) : (
            <article className="space-y-5">
              <header className="flex items-start justify-between gap-4 flex-wrap">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-xl font-semibold text-neutral-100">
                      {selected.name}
                    </h2>
                    {categoryBadge(selected.category)}
                    {statusPill(selected.status)}
                  </div>
                  <a
                    href={`mailto:${selected.email}?subject=${encodeURIComponent(
                      "Re: your message to PrintLay"
                    )}`}
                    className="text-sm text-violet-300 hover:text-violet-200"
                  >
                    {selected.email}
                  </a>
                  {selected.phone && (
                    <div className="mt-0.5">
                      <a
                        href={`tel:${selected.phone.replace(/\s+/g, "")}`}
                        className="inline-flex items-center gap-1.5 text-sm text-emerald-300 hover:text-emerald-200"
                      >
                        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                          <path
                            d="M2.5 2.5a1 1 0 011-1h1.2a1 1 0 011 .76l.4 1.6a1 1 0 01-.27 1L5 5.8a7 7 0 003.2 3.2l.94-.84a1 1 0 011-.27l1.6.4a1 1 0 01.76 1V10.5a1 1 0 01-1 1A8 8 0 012.5 3.5z"
                            fill="currentColor"
                          />
                        </svg>
                        {selected.phone}
                      </a>
                    </div>
                  )}
                  <div className="text-xs text-neutral-500 mt-1">
                    {new Date(selected.created_at).toLocaleString()}
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <a
                    href={`mailto:${selected.email}?subject=${encodeURIComponent(
                      `Re: your ${CATEGORY_META[selected.category]?.label ?? "message"} enquiry`
                    )}&body=${encodeURIComponent(
                      `Hi ${selected.name.split(" ")[0]},\n\n`
                    )}`}
                    className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-9 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400"
                  >
                    Reply by email
                  </a>
                  {selected.status !== "responded" && (
                    <button
                      onClick={() => setStatus(selected.id, "responded")}
                      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-3 h-9 text-xs font-semibold hover:bg-emerald-500/20"
                    >
                      Mark responded
                    </button>
                  )}
                  {selected.status !== "archived" ? (
                    <button
                      onClick={() => setStatus(selected.id, "archived")}
                      className="rounded-lg border border-neutral-700 px-3 h-9 text-xs font-medium text-neutral-300 hover:border-neutral-500"
                    >
                      Archive
                    </button>
                  ) : (
                    <button
                      onClick={() => setStatus(selected.id, "read")}
                      className="rounded-lg border border-neutral-700 px-3 h-9 text-xs font-medium text-neutral-300 hover:border-neutral-500"
                    >
                      Restore
                    </button>
                  )}
                </div>
              </header>

              <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-sm text-neutral-200 whitespace-pre-wrap leading-relaxed">
                {selected.message}
              </div>

              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                  <dt className="text-[10px] uppercase tracking-widest text-neutral-500">
                    Source
                  </dt>
                  <dd className="mt-0.5 text-neutral-200">{selected.source}</dd>
                </div>
                <div className="rounded-lg border border-neutral-800 bg-neutral-950/60 p-3">
                  <dt className="text-[10px] uppercase tracking-widest text-neutral-500">
                    Page
                  </dt>
                  <dd className="mt-0.5 text-neutral-200 truncate">
                    {selected.page_url ? (
                      <a
                        href={selected.page_url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-violet-300 hover:text-violet-200 break-all"
                      >
                        {selected.page_url}
                      </a>
                    ) : (
                      <span className="text-neutral-500">—</span>
                    )}
                  </dd>
                </div>
                {selected.user_id && (
                  <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 sm:col-span-2">
                    <dt className="text-[10px] uppercase tracking-widest text-violet-300">
                      Existing user
                    </dt>
                    <dd className="mt-0.5">
                      <Link
                        to={`/app/admin/users?focus=${selected.user_id}`}
                        className="text-sm text-violet-200 hover:text-violet-100 underline underline-offset-2"
                      >
                        Open user record →
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}
