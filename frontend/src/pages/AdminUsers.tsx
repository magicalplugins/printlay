import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  AdminUserRow,
  UserDetail,
  UserPatch,
  getAdminUsers,
  getUserDetail,
  patchAdminUser,
} from "../api/admin";

const PAGE_SIZE = 50;

// ---- Formatting helpers ----

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString();
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

// ---- Status pill ----

function PlanPill({ plan, sub, trialEndsAt }: {
  plan: string;
  sub: string | null;
  trialEndsAt: string | null;
}) {
  const now = Date.now();
  const isTrialing = !!trialEndsAt && new Date(trialEndsAt).getTime() > now && sub !== "active";
  const daysLeft = isTrialing
    ? Math.max(0, Math.ceil((new Date(trialEndsAt!).getTime() - now) / 86400000))
    : null;

  if (sub === "active") {
    const cls =
      plan === "enterprise"
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : plan === "studio"
        ? "border-fuchsia-500/40 bg-fuchsia-500/10 text-fuchsia-200"
        : plan === "pro"
        ? "border-violet-500/40 bg-violet-500/10 text-violet-200"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    return (
      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border ${cls}`}>
        {plan}
      </span>
    );
  }

  if (sub === "past_due") {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border border-rose-500/40 bg-rose-500/10 text-rose-200">
        past due
      </span>
    );
  }

  if (sub === "canceled") {
    return (
      <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border border-neutral-700 bg-neutral-900 text-neutral-400">
        canceled
      </span>
    );
  }

  if (isTrialing && daysLeft !== null) {
    const cls =
      daysLeft <= 2
        ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
        : daysLeft <= 5
        ? "border-amber-500/40 bg-amber-500/10 text-amber-200"
        : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
    return (
      <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] border ${cls}`}>
        trial · {daysLeft}d
      </span>
    );
  }

  return (
    <span className="inline-flex px-2 py-0.5 rounded-full text-[10px] uppercase tracking-widest border border-neutral-800 bg-neutral-950 text-neutral-600">
      locked
    </span>
  );
}

// ---- Filter types ----

type StatusFilter =
  | "all"
  | "active"
  | "trialing"
  | "past_due"
  | "canceled"
  | "locked"
  | "deactivated";

function matchesStatus(u: AdminUserRow, f: StatusFilter): boolean {
  if (f === "all") return true;
  if (f === "deactivated") return !u.is_active;
  if (!u.is_active) return false;
  const now = Date.now();
  const isTrialing =
    !!u.trial_ends_at &&
    new Date(u.trial_ends_at).getTime() > now &&
    u.stripe_subscription_status !== "active";
  if (f === "trialing") return isTrialing;
  if (f === "active") return u.stripe_subscription_status === "active";
  if (f === "past_due") return u.stripe_subscription_status === "past_due";
  if (f === "canceled") return u.stripe_subscription_status === "canceled";
  if (f === "locked") {
    return (
      u.stripe_subscription_status !== "active" &&
      u.tier !== "enterprise" &&
      !isTrialing
    );
  }
  return true;
}

// ---- Main page ----

export default function AdminUsers() {
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedQ(q.trim());
      setPage(0);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const loadRows = () => {
    setLoading(true);
    setErr(null);
    getAdminUsers(debouncedQ || undefined, PAGE_SIZE, page * PAGE_SIZE)
      .then((res) => {
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((e) => setErr(String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    getAdminUsers(debouncedQ || undefined, PAGE_SIZE, page * PAGE_SIZE)
      .then((res) => {
        if (cancelled) return;
        setRows(res.items);
        setTotal(res.total);
      })
      .catch((e) => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [debouncedQ, page]);

  const filtered = useMemo(
    () => (rows ?? []).filter((u) => matchesStatus(u, statusFilter)),
    [rows, statusFilter]
  );

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const FILTERS: [StatusFilter, string][] = [
    ["all", "All"],
    ["active", "Active"],
    ["trialing", "Trialing"],
    ["past_due", "Past due"],
    ["canceled", "Canceled"],
    ["locked", "Locked"],
    ["deactivated", "Deactivated"],
  ];

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <div className="text-xs text-neutral-500 mb-1">
            <Link to="/app/admin" className="hover:text-neutral-300">← Admin</Link>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Users</h1>
          <p className="text-neutral-500 text-sm mt-1">
            Search, filter, and manage every account — plan, billing status, and usage.
          </p>
        </div>
        <div className="text-sm text-neutral-400">
          {loading ? "Loading…" : `${total} user${total === 1 ? "" : "s"} total`}
        </div>
      </header>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[260px]">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500"
            width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Search by email…"
            className="w-full h-10 rounded-lg border border-neutral-800 bg-neutral-950 pl-9 pr-3 text-sm outline-none focus:border-violet-500"
          />
        </div>
        <div className="flex rounded-lg border border-neutral-800 overflow-x-auto">
          {FILTERS.map(([id, label]) => (
            <button key={id} onClick={() => setStatusFilter(id)}
              className={`px-3 h-10 text-xs uppercase tracking-widest whitespace-nowrap ${
                statusFilter === id
                  ? "bg-violet-500/15 text-violet-200"
                  : "text-neutral-400 hover:bg-neutral-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="text-rose-400 text-sm">{err}</div>}

      {/* Table */}
      <div className="rounded-xl border border-neutral-800 overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
            <tr>
              <th className="text-left font-normal px-4 py-2.5">User</th>
              <th className="text-left font-normal px-4 py-2.5">Plan</th>
              <th className="text-left font-normal px-4 py-2.5">Renews</th>
              <th className="text-right font-normal px-4 py-2.5">Jobs</th>
              <th className="text-right font-normal px-4 py-2.5">PDFs</th>
              <th className="text-right font-normal px-4 py-2.5">Joined</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody className="divide-y divide-neutral-900">
            {filtered.map((u) => (
              <tr key={u.id}
                className="hover:bg-neutral-900/40 cursor-pointer"
                onClick={() => setOpenId(u.id)}
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{u.email}</span>
                    {u.founder_member && (
                      <span className="rounded-full bg-violet-500/15 border border-violet-500/40 px-1.5 py-0 text-[9px] font-medium text-violet-300 uppercase tracking-wider">
                        Founder
                      </span>
                    )}
                    {!u.is_active && (
                      <span className="rounded-full border border-neutral-700 bg-neutral-800 px-1.5 py-0 text-[9px] text-neutral-500 uppercase">
                        suspended
                      </span>
                    )}
                  </div>
                  {(u.company_name || u.phone) && (
                    <div className="text-xs text-neutral-500 flex items-center gap-1.5">
                      {u.company_name && <span>{u.company_name}</span>}
                      {u.company_name && u.phone && <span>·</span>}
                      {u.phone && <span>{u.phone}</span>}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <PlanPill
                    plan={u.plan}
                    sub={u.stripe_subscription_status}
                    trialEndsAt={u.trial_ends_at}
                  />
                </td>
                <td className="px-4 py-2.5 text-neutral-400 text-xs">
                  {formatDate(u.stripe_current_period_end)}
                </td>
                <td className="px-4 py-2.5 text-right tabular-nums">{u.jobs_total}</td>
                <td className="px-4 py-2.5 text-right tabular-nums">{u.pdfs_total}</td>
                <td className="px-4 py-2.5 text-right text-neutral-500 text-xs">
                  {formatRelative(u.created_at)}
                </td>
                <td className="px-2 py-2.5 text-right text-neutral-600">›</td>
              </tr>
            ))}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-neutral-500">
                  No users match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <button onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0 || loading}
            className="rounded-md border border-neutral-800 px-3 h-8 hover:border-neutral-600 disabled:opacity-40"
          >← Prev</button>
          <div className="text-neutral-500">Page {page + 1} of {totalPages}</div>
          <button onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1 || loading}
            className="rounded-md border border-neutral-800 px-3 h-8 hover:border-neutral-600 disabled:opacity-40"
          >Next →</button>
        </div>
      )}

      {openId && (
        <UserDrawer
          userId={openId}
          onClose={() => setOpenId(null)}
          onPatched={loadRows}
        />
      )}
    </div>
  );
}

// ---- User detail drawer ----

function UserDrawer({
  userId,
  onClose,
  onPatched,
}: {
  userId: string;
  onClose: () => void;
  onPatched: () => void;
}) {
  const [data, setData] = useState<UserDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [patchErr, setPatchErr] = useState<string | null>(null);
  const [busyPatch, setBusyPatch] = useState(false);
  const [savedHint, setSavedHint] = useState("");

  const reload = (id: string) => {
    setData(null);
    setErr(null);
    getUserDetail(id).then(setData).catch((e) => setErr(String(e)));
  };

  useEffect(() => {
    reload(userId);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [userId, onClose]);

  const applyPatch = async (patch: UserPatch, hint: string) => {
    setBusyPatch(true);
    setPatchErr(null);
    try {
      await patchAdminUser(userId, patch);
      setSavedHint(hint);
      setTimeout(() => setSavedHint(""), 2000);
      reload(userId);
      onPatched();
    } catch (e) {
      setPatchErr(String(e));
    } finally {
      setBusyPatch(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex justify-end"
      onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-xl bg-neutral-950 border-l border-neutral-800 shadow-2xl h-full overflow-y-auto">

        {/* Header */}
        <div className="sticky top-0 bg-neutral-950/95 backdrop-blur border-b border-neutral-900 px-5 py-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-xs uppercase tracking-widest text-neutral-500">User</div>
            {data ? (
              <div className="font-semibold truncate">{data.email}</div>
            ) : (
              <div className="text-neutral-500 text-sm">Loading…</div>
            )}
          </div>
          <button onClick={onClose}
            className="rounded-lg border border-neutral-800 px-3 h-8 text-xs text-neutral-300 hover:border-neutral-600">
            Close
          </button>
        </div>

        {err && <div className="px-5 py-4 text-rose-300 text-sm">{err}</div>}

        {data && (
          <div className="px-5 py-5 space-y-7">

            {/* Billing */}
            <section className="space-y-3">
              <h3 className="text-xs uppercase tracking-widest text-neutral-500">Billing</h3>
              <div className="flex items-center gap-2 flex-wrap">
                <PlanPill
                  plan={data.plan}
                  sub={data.stripe_subscription_status}
                  trialEndsAt={data.trial_ends_at}
                />
                {data.founder_member && (
                  <span className="rounded-full bg-violet-500/15 border border-violet-500/40 px-2 py-0.5 text-[10px] font-medium text-violet-300">
                    Founder
                  </span>
                )}
                {!data.is_active && (
                  <span className="rounded-full border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-[10px] text-neutral-400">
                    Suspended
                  </span>
                )}
              </div>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-neutral-500">Plan</dt>
                <dd className="text-neutral-200 font-medium capitalize">{data.plan}</dd>
                <dt className="text-neutral-500">Sub status</dt>
                <dd className="text-neutral-200">{data.stripe_subscription_status || "—"}</dd>
                <dt className="text-neutral-500">Renews / expires</dt>
                <dd className="text-neutral-200">{formatDate(data.stripe_current_period_end)}</dd>
                <dt className="text-neutral-500">Trial ends</dt>
                <dd className="text-neutral-200">{formatDate(data.trial_ends_at)}</dd>
                <dt className="text-neutral-500">Stripe customer</dt>
                <dd className="text-neutral-500 text-xs font-mono truncate">
                  {data.stripe_customer_id ? (
                    <a
                      href={`https://dashboard.stripe.com/customers/${data.stripe_customer_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-violet-300 hover:text-violet-200 underline-offset-2 hover:underline"
                      title="Open in Stripe dashboard"
                    >
                      {data.stripe_customer_id} ↗
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt className="text-neutral-500">Stripe sub</dt>
                <dd className="text-neutral-500 text-xs font-mono truncate">
                  {data.stripe_subscription_id ? (
                    <a
                      href={`https://dashboard.stripe.com/subscriptions/${data.stripe_subscription_id}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-violet-300 hover:text-violet-200 underline-offset-2 hover:underline"
                      title="Open in Stripe dashboard — change plan, cancel, view invoices"
                    >
                      {data.stripe_subscription_id} ↗
                    </a>
                  ) : (
                    "—"
                  )}
                </dd>
                <dt className="text-neutral-500">Price ID</dt>
                <dd className="text-neutral-500 text-xs font-mono truncate">{data.stripe_price_id || "—"}</dd>
              </dl>
              {data.stripe_subscription_id && (
                <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
                  To cancel or refund: open the subscription in Stripe ↗.
                  Our DB updates automatically once the webhook fires
                  (status flips to <code>canceled</code> within a few seconds).
                </p>
              )}
            </section>

            {/* Admin actions */}
            <section className="space-y-3 rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
              <h3 className="text-xs uppercase tracking-widest text-neutral-500">Admin overrides</h3>
              <p className="text-xs text-neutral-500">
                These override entitlement resolution without touching Stripe.
                Use Enterprise for invoiced customers; Founder badge is cosmetic + lifetime.
              </p>
              {patchErr && <div className="text-xs text-rose-300">{patchErr}</div>}
              {savedHint && <div className="text-xs text-emerald-300">{savedHint} ✓</div>}

              {/* Tier override */}
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-neutral-400 w-20">Tier</span>
                {(["locked", "starter", "pro", "studio", "enterprise"] as const).map((t) => (
                  <button key={t}
                    disabled={busyPatch || data.tier === t}
                    onClick={() => applyPatch({ tier: t }, `Tier set to ${t}`)}
                    className={`rounded-md border px-2.5 py-1 text-xs transition disabled:opacity-40 ${
                      data.tier === t
                        ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                        : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>

              {/* Founder badge toggle */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400 w-20">Founder</span>
                <button
                  disabled={busyPatch}
                  onClick={() => applyPatch(
                    { founder_member: !data.founder_member },
                    data.founder_member ? "Founder badge removed" : "Founder badge granted"
                  )}
                  className={`rounded-md border px-3 py-1 text-xs transition disabled:opacity-40 ${
                    data.founder_member
                      ? "border-violet-500/60 bg-violet-500/15 text-violet-200"
                      : "border-neutral-700 text-neutral-400 hover:border-violet-500/40"
                  }`}
                >
                  {data.founder_member ? "✓ Founder — click to remove" : "Grant Founder badge"}
                </button>
              </div>

              {/* Account suspension */}
              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-400 w-20">Account</span>
                <button
                  disabled={busyPatch}
                  onClick={() => {
                    const verb = data.is_active ? "suspend" : "reactivate";
                    if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} this account?`)) return;
                    applyPatch(
                      { is_active: !data.is_active },
                      data.is_active ? "Account suspended" : "Account reactivated"
                    );
                  }}
                  className={`rounded-md border px-3 py-1 text-xs transition disabled:opacity-40 ${
                    data.is_active
                      ? "border-rose-500/40 text-rose-300 hover:bg-rose-500/10"
                      : "border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10"
                  }`}
                >
                  {data.is_active ? "Suspend account" : "Reactivate account"}
                </button>
              </div>
            </section>

            {/* Profile */}
            <section className="space-y-2">
              <h3 className="text-xs uppercase tracking-widest text-neutral-500">Profile</h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-neutral-500">Company</dt>
                <dd className="text-neutral-200">{data.company_name || <span className="text-neutral-600">—</span>}</dd>
                <dt className="text-neutral-500">Phone</dt>
                <dd className="text-neutral-200">{data.phone || <span className="text-neutral-600">—</span>}</dd>
                <dt className="text-neutral-500">Joined</dt>
                <dd className="text-neutral-200">{formatDate(data.created_at)} · {formatRelative(data.created_at)}</dd>
              </dl>
            </section>

            {/* Counts */}
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">Usage</h3>
              <div className="grid grid-cols-3 gap-2">
                {[
                  { l: "PDFs total", v: data.counts.pdfs_total },
                  { l: "PDFs 30d", v: data.counts.pdfs_30d },
                  { l: "PDFs 7d", v: data.counts.pdfs_7d },
                  { l: "Jobs", v: data.counts.jobs_total },
                  { l: "Templates", v: data.counts.templates_total },
                  { l: "Assets", v: data.counts.asset_count },
                ].map((c) => (
                  <div key={c.l} className="rounded-lg border border-neutral-900 bg-neutral-950 px-3 py-2">
                    <div className="text-[10px] uppercase tracking-widest text-neutral-500">{c.l}</div>
                    <div className="text-lg font-semibold tabular-nums">{c.v}</div>
                  </div>
                ))}
                <div className="col-span-3 rounded-lg border border-neutral-900 bg-neutral-950 px-3 py-2">
                  <div className="text-[10px] uppercase tracking-widest text-neutral-500">Storage</div>
                  <div className="text-lg font-semibold tabular-nums">{formatBytes(data.counts.storage_bytes)}</div>
                </div>
              </div>
            </section>

            {/* Catalogue subscriptions */}
            {data.catalogue_subscriptions.length > 0 && (
              <section>
                <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
                  Subscribed catalogues
                </h3>
                <ul className="space-y-1.5 text-sm">
                  {data.catalogue_subscriptions.map((c) => (
                    <li key={c.id}
                      className="flex items-center justify-between rounded-md bg-neutral-950 border border-neutral-900 px-3 py-1.5">
                      <span>{c.name}</span>
                      <span className="text-xs text-neutral-500">since {formatDate(c.subscribed_at)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Recent jobs */}
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
                Recent jobs ({data.recent_jobs.length})
              </h3>
              {data.recent_jobs.length === 0 ? (
                <div className="text-sm text-neutral-600">No jobs yet.</div>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.recent_jobs.map((j) => (
                    <li key={j.id}
                      className="flex items-center justify-between border-b border-neutral-900 py-1.5">
                      <span className="truncate">{j.name}</span>
                      <span className="text-xs text-neutral-500">{formatRelative(j.created_at)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Recent PDFs */}
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
                Recent PDFs ({data.recent_outputs.length})
              </h3>
              {data.recent_outputs.length === 0 ? (
                <div className="text-sm text-neutral-600">No PDFs generated yet.</div>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.recent_outputs.map((o) => (
                    <li key={o.id}
                      className="flex items-center justify-between gap-3 border-b border-neutral-900 py-1.5">
                      <span className="truncate min-w-0">{o.name}</span>
                      <span className="text-xs text-neutral-500 whitespace-nowrap">
                        {o.slots_filled}/{o.slots_total} slots · {formatBytes(o.file_size)} · {formatRelative(o.created_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
