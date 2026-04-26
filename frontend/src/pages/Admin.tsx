import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ActiveUserRow,
  BillingHealth,
  DropoutRow,
  StatsSummary,
  SubscriberRow,
  getActiveUsers,
  getAdminStats,
  getBillingHealth,
  getDropouts,
  getSubscribers,
} from "../api/admin";
import { MessageComposer } from "../components/admin/MessageComposer";

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
  return `${Math.floor(diff / 86400)}d ago`;
}

function dropoutBadge(reason: DropoutRow["reason"]) {
  const styles: Record<DropoutRow["reason"], string> = {
    trial_expired: "bg-amber-500/15 text-amber-300 border-amber-500/30",
    canceled: "bg-neutral-500/15 text-neutral-300 border-neutral-500/30",
    past_due: "bg-rose-500/15 text-rose-300 border-rose-500/30",
    stuck_signup: "bg-sky-500/15 text-sky-300 border-sky-500/30",
    stuck_template: "bg-violet-500/15 text-violet-300 border-violet-500/30",
  };
  const labels: Record<DropoutRow["reason"], string> = {
    trial_expired: "Trial expired",
    canceled: "Canceled",
    past_due: "Payment failing",
    stuck_signup: "Never made template",
    stuck_template: "Never generated PDF",
  };
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${styles[reason]}`}
    >
      {labels[reason]}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string | number;
  sub?: string;
  tone?: "default" | "good" | "warn" | "bad";
}) {
  const toneCls = {
    default: "border-neutral-800 bg-neutral-950/60",
    good: "border-emerald-500/20 bg-emerald-500/5",
    warn: "border-amber-500/20 bg-amber-500/5",
    bad: "border-rose-500/20 bg-rose-500/5",
  }[tone];
  return (
    <div className={`rounded-xl border ${toneCls} p-4`}>
      <div className="text-[10px] uppercase tracking-widest text-neutral-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {sub && <div className="mt-1 text-xs text-neutral-400">{sub}</div>}
    </div>
  );
}

/** Tiny inline sparkline (no chart library). 30 daily points. */
function Sparkline({ points, accent }: { points: number[]; accent: string }) {
  const w = 240;
  const h = 60;
  if (points.length === 0) return null;
  const max = Math.max(1, ...points);
  const dx = w / Math.max(1, points.length - 1);
  const path = points
    .map((p, i) => {
      const x = i * dx;
      const y = h - (p / max) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const areaPath = `${path} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12">
      <path d={areaPath} fill={accent} fillOpacity={0.15} />
      <path d={path} stroke={accent} strokeWidth="1.5" fill="none" />
    </svg>
  );
}

export default function Admin() {
  const [stats, setStats] = useState<StatsSummary | null>(null);
  const [active, setActive] = useState<ActiveUserRow[] | null>(null);
  const [subs, setSubs] = useState<SubscriberRow[] | null>(null);
  const [drops, setDrops] = useState<DropoutRow[] | null>(null);
  const [billingHealth, setBillingHealth] = useState<BillingHealth | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    Promise.all([
      getAdminStats(),
      getActiveUsers(20),
      getSubscribers(),
      getDropouts(),
      getBillingHealth().catch(() => null),
    ])
      .then(([s, a, sb, d, bh]) => {
        if (cancelled) return;
        setStats(s);
        setActive(a);
        setSubs(sb);
        setDrops(d);
        setBillingHealth(bh);
      })
      .catch((e) => !cancelled && setErr(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const churnRate = useMemo(() => {
    if (!stats) return null;
    const canceled =
      stats.subscription_statuses.find((r) => r.status === "canceled")?.count ?? 0;
    const total = stats.active_subscribers + canceled;
    if (total === 0) return null;
    return Math.round((canceled / total) * 100);
  }, [stats]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-6 py-12 text-neutral-400 text-sm">
        Loading admin dashboard…
      </div>
    );
  }

  if (err) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12 text-rose-300 text-sm">
        Couldn't load admin data: {err}
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-6 py-8 space-y-10">
      <header className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Admin</h1>
          <p className="text-neutral-500 text-sm mt-1">
            System overview, subscriptions, and engagement.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to="/app/admin/users"
            className="inline-flex items-center gap-2 rounded-lg border border-neutral-700 px-4 h-10 text-sm font-medium text-neutral-200 hover:border-neutral-500"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <circle cx="7" cy="4.5" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M2 12c0-2.5 2.2-4.5 5-4.5s5 2 5 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            All users
          </Link>
          <button
            onClick={() => setComposerOpen(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 h-10 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path
                d="M1 1l12 6-12 6 3-6L1 1z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            Compose message
          </button>
        </div>
      </header>
      {composerOpen && (
        <MessageComposer onClose={() => setComposerOpen(false)} />
      )}

      {stats && (
        <>
          <section>
            <h2 className="text-xs uppercase tracking-widest text-neutral-500 mb-3">
              At a glance
            </h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard
                label="Users"
                value={stats.users_total}
                sub={`+${stats.users_signups_24h} today`}
              />
              <StatCard
                label="Subscribers"
                value={stats.active_subscribers}
                sub={`${stats.trialing_users} trialing · ${stats.founder_members} founders`}
                tone="good"
              />
              <StatCard
                label="Past due"
                value={stats.past_due_users}
                sub="payment failing — at risk"
                tone={stats.past_due_users > 0 ? "warn" : "default"}
              />
              <StatCard
                label="PDFs 24h"
                value={stats.pdfs_24h}
                sub={`${stats.pdfs_7d} this week`}
              />
              <StatCard
                label="Storage"
                value={formatBytes(stats.storage_bytes)}
                sub={`${stats.assets_total} assets`}
              />
              <StatCard
                label="Churn"
                value={churnRate === null ? "—" : `${churnRate}%`}
                sub="cancelled ÷ (cancelled + active)"
                tone={churnRate !== null && churnRate > 10 ? "warn" : "default"}
              />
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
              <div className="flex items-baseline justify-between mb-1">
                <h3 className="text-sm font-semibold">PDFs / day</h3>
                <span className="text-xs text-neutral-500">last 30 days</span>
              </div>
              <Sparkline
                points={stats.pdfs_per_day_30d.map((p) => p.count)}
                accent="rgb(167 139 250)"
              />
              <div className="text-xs text-neutral-500 mt-1">
                {stats.pdfs_30d} in last 30 days · peak{" "}
                {Math.max(...stats.pdfs_per_day_30d.map((p) => p.count))} in a
                day
              </div>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
              <div className="flex items-baseline justify-between mb-1">
                <h3 className="text-sm font-semibold">Sign-ups / day</h3>
                <span className="text-xs text-neutral-500">last 30 days</span>
              </div>
              <Sparkline
                points={stats.signups_per_day_30d.map((p) => p.count)}
                accent="rgb(244 114 182)"
              />
              <div className="text-xs text-neutral-500 mt-1">
                {stats.users_signups_30d} new users · peak{" "}
                {Math.max(...stats.signups_per_day_30d.map((p) => p.count))} in
                a day
              </div>
            </div>
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
              <h3 className="text-sm font-semibold mb-3">Plan distribution</h3>
              <ul className="space-y-1.5 text-sm">
                {stats.tiers.map((t) => (
                  <li key={t.tier} className="flex items-center gap-3">
                    <span className="w-32 text-neutral-300">{t.tier}</span>
                    <div className="flex-1 h-2 rounded-full bg-neutral-900 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-violet-500 to-fuchsia-500"
                        style={{
                          width: `${
                            (t.count / Math.max(1, stats.users_total)) * 100
                          }%`,
                        }}
                      />
                    </div>
                    <span className="w-12 text-right tabular-nums text-neutral-400">
                      {t.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4">
              <h3 className="text-sm font-semibold mb-3">Subscription status</h3>
              <ul className="space-y-1.5 text-sm">
                {[
                  { status: "active", count: stats.active_subscribers },
                  { status: "trialing", count: stats.trialing_users },
                  { status: "locked", count: stats.locked_users },
                  { status: "past_due", count: stats.past_due_users },
                ].map((s) => (
                  <li key={s.status} className="flex items-center gap-3">
                    <span className="w-32 text-neutral-300">{s.status}</span>
                    <div className="flex-1 h-2 rounded-full bg-neutral-900 overflow-hidden">
                      <div
                        className={`h-full ${
                          s.status === "active"
                            ? "bg-emerald-500"
                            : s.status === "trialing"
                              ? "bg-violet-500"
                              : s.status === "past_due"
                                ? "bg-rose-500"
                                : "bg-neutral-600"
                        }`}
                        style={{
                          width: `${(s.count / Math.max(1, stats.users_total)) * 100}%`,
                        }}
                      />
                    </div>
                    <span className="w-12 text-right tabular-nums text-neutral-400">
                      {s.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </>
      )}

      {/* Most active users */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-500">
            Most active users · last 30 days
          </h2>
          <span className="text-xs text-neutral-500">
            {active?.length ?? 0} shown
          </span>
        </div>
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left font-normal px-4 py-2">User</th>
                <th className="text-left font-normal px-4 py-2">Plan</th>
                <th className="text-right font-normal px-4 py-2">Jobs</th>
                <th className="text-right font-normal px-4 py-2">PDFs</th>
                <th className="text-right font-normal px-4 py-2">Last PDF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {(active ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{u.email}</div>
                    {u.company_name && (
                      <div className="text-xs text-neutral-500">
                        {u.company_name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-neutral-400">{u.tier}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {u.jobs_30d}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">
                    {u.pdfs_30d}
                  </td>
                  <td className="px-4 py-2.5 text-right text-neutral-400">
                    {formatRelative(u.last_pdf_at)}
                  </td>
                </tr>
              ))}
              {(active ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-6 text-center text-neutral-500 text-sm"
                  >
                    No PDFs generated in the last 30 days yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Subscribers */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-500">
            Active subscribers
          </h2>
          <span className="text-xs text-neutral-500">
            {subs?.length ?? 0} active
          </span>
        </div>
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left font-normal px-4 py-2">User</th>
                <th className="text-left font-normal px-4 py-2">Plan</th>
                <th className="text-right font-normal px-4 py-2">Renews</th>
                <th className="text-right font-normal px-4 py-2">Founder</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {(subs ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{u.email}</div>
                    {u.company_name && (
                      <div className="text-xs text-neutral-500">
                        {u.company_name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-emerald-300 capitalize">{u.plan}</td>
                  <td className="px-4 py-2.5 text-right text-neutral-400">
                    {u.stripe_current_period_end
                      ? new Date(u.stripe_current_period_end).toLocaleDateString()
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    {u.founder_member && (
                      <span className="text-xs text-violet-300">✓</span>
                    )}
                  </td>
                </tr>
              ))}
              {(subs ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-neutral-500 text-sm"
                  >
                    No active subscribers yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Dropouts */}
      <section>
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-xs uppercase tracking-widest text-neutral-500">
            Drop-offs · need attention
          </h2>
          <span className="text-xs text-neutral-500">
            {drops?.length ?? 0} candidates
          </span>
        </div>
        <div className="rounded-xl border border-neutral-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-neutral-950/80 text-neutral-500 text-xs uppercase tracking-widest">
              <tr>
                <th className="text-left font-normal px-4 py-2">User</th>
                <th className="text-left font-normal px-4 py-2">Reason</th>
                <th className="text-left font-normal px-4 py-2">Plan</th>
                <th className="text-right font-normal px-4 py-2">
                  Last active
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-neutral-900">
              {(drops ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-neutral-900/40">
                  <td className="px-4 py-2.5">
                    <div className="font-medium">{u.email}</div>
                    {u.company_name && (
                      <div className="text-xs text-neutral-500">
                        {u.company_name}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">{dropoutBadge(u.reason)}</td>
                  <td className="px-4 py-2.5 text-neutral-400 capitalize">{u.plan}</td>
                  <td className="px-4 py-2.5 text-right text-neutral-400">
                    {formatRelative(u.last_active_at)}
                  </td>
                </tr>
              ))}
              {(drops ?? []).length === 0 && (
                <tr>
                  <td
                    colSpan={4}
                    className="px-4 py-6 text-center text-neutral-500 text-sm"
                  >
                    Nobody's dropped off yet — nice.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {billingHealth && <StripeConfigCard health={billingHealth} />}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Stripe configuration diagnostic
   ───────────────────────────────────────────────────────────────────── */

function StripeConfigCard({ health }: { health: BillingHealth }) {
  const items: { key: keyof BillingHealth["items"]; label: string; secret: string }[] = [
    { key: "secret_key", label: "Secret API key", secret: "STRIPE_SECRET_KEY" },
    { key: "webhook_secret", label: "Webhook signing secret", secret: "STRIPE_WEBHOOK_SECRET" },
    { key: "price_starter_monthly", label: "Starter — monthly", secret: "STRIPE_PRICE_STARTER_MONTHLY" },
    { key: "price_starter_annual", label: "Starter — annual", secret: "STRIPE_PRICE_STARTER_ANNUAL" },
    { key: "price_pro_monthly", label: "Pro — monthly", secret: "STRIPE_PRICE_PRO_MONTHLY" },
    { key: "price_pro_annual", label: "Pro — annual", secret: "STRIPE_PRICE_PRO_ANNUAL" },
    { key: "price_studio_monthly", label: "Studio — monthly", secret: "STRIPE_PRICE_STUDIO_MONTHLY" },
    { key: "price_studio_annual", label: "Studio — annual", secret: "STRIPE_PRICE_STUDIO_ANNUAL" },
  ];

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold tracking-tight">Stripe configuration</h2>
          <p className="text-xs text-neutral-500 mt-1 max-w-xl">
            Read-only health check. For security, secret values are stored as
            Fly secrets and can only be set with{" "}
            <code className="text-neutral-300 bg-neutral-900 rounded px-1 py-0.5">
              fly secrets set
            </code>{" "}
            from the command line — never the admin UI.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold border ${
            health.fully_configured
              ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300"
              : "bg-amber-500/10 border-amber-500/30 text-amber-300"
          }`}
        >
          <span
            className={`h-1.5 w-1.5 rounded-full ${
              health.fully_configured ? "bg-emerald-400" : "bg-amber-400 animate-pulse"
            }`}
          />
          {health.fully_configured ? "Fully wired" : "Incomplete"}
        </span>
      </div>

      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 divide-y divide-neutral-900">
        {items.map(({ key, label, secret }) => {
          const ok = health.items[key];
          return (
            <div
              key={key}
              className="flex items-center justify-between gap-3 px-4 py-2.5"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${
                    ok ? "bg-emerald-400" : "bg-rose-400"
                  }`}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="text-sm text-neutral-200">{label}</div>
                  <code className="text-[10px] text-neutral-500 font-mono">
                    {secret}
                  </code>
                </div>
              </div>
              <span
                className={`text-xs font-medium ${
                  ok ? "text-emerald-300" : "text-rose-300"
                }`}
              >
                {ok ? "Set" : "Missing"}
              </span>
            </div>
          );
        })}
      </div>

      {!health.fully_configured && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <p className="text-sm text-amber-200 font-medium">
            Some Stripe settings are missing.
          </p>
          <p className="text-xs text-amber-200/70">
            Until everything's set, checkout will return 503 and webhooks will
            fail signature verification. Set the missing values from your
            terminal:
          </p>
          <pre className="text-[11px] bg-neutral-950/60 rounded-lg p-3 overflow-x-auto text-neutral-300">
{`fly secrets set \\
  STRIPE_SECRET_KEY=sk_live_... \\
  STRIPE_WEBHOOK_SECRET=whsec_... \\
  STRIPE_PRICE_PRO_MONTHLY=price_... \\
  --app printlay`}
          </pre>
          <p className="text-xs text-amber-200/70">
            Then redeploy. See <code>SETUP.md §4d.2</code> for the complete
            playbook including creating products, prices, and the webhook
            endpoint in the Stripe Dashboard.
          </p>
        </div>
      )}
    </section>
  );
}
