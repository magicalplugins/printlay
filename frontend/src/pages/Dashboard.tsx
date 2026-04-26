import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  BillingStatus,
  BillingUsage,
  getBillingStatus,
  getBillingUsage,
  Plan,
} from "../api/billing";
import { listOutputs, Output } from "../api/outputs";
import { useMe } from "../auth/MeProvider";

const PLAN_LABEL: Record<Plan, string> = {
  locked: "Locked",
  starter: "Starter",
  pro: "Pro",
  studio: "Studio",
  enterprise: "Enterprise",
};

const PLAN_PILL: Record<Plan, string> = {
  locked: "border-rose-500/40 bg-rose-500/10 text-rose-300",
  starter: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  pro: "border-violet-500/40 bg-violet-500/10 text-violet-300",
  studio: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  enterprise: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
};

export default function Dashboard() {
  const { me } = useMe();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [usage, setUsage] = useState<BillingUsage | null>(null);
  const [recent, setRecent] = useState<Output[] | null>(null);

  useEffect(() => {
    getBillingStatus().then(setStatus).catch(() => setStatus(null));
    getBillingUsage().then(setUsage).catch(() => setUsage(null));
    listOutputs()
      .then((rows) => setRecent(rows.slice(0, 5)))
      .catch(() => setRecent([]));
  }, []);

  const greeting = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 5) return "Working late";
    if (hour < 12) return "Good morning";
    if (hour < 18) return "Good afternoon";
    return "Good evening";
  }, []);

  const firstName = useMemo(() => {
    if (!me?.email) return null;
    const local = me.email.split("@")[0];
    // Try to humanise — split on dot/dash, capitalise the first chunk.
    const word = local.split(/[._-]/)[0];
    if (!word) return null;
    return word.charAt(0).toUpperCase() + word.slice(1);
  }, [me?.email]);

  const trialDaysLeft = useMemo(() => {
    if (!status?.trial_ends_at) return null;
    if (!status.is_trialing) return null;
    return Math.max(
      0,
      Math.ceil(
        (new Date(status.trial_ends_at).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24)
      )
    );
  }, [status]);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12 space-y-10">
      {/* ─── Hero ───────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight">
            {greeting}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="text-neutral-400 mt-1.5 text-sm sm:text-base truncate">
            Signed in as <span className="text-neutral-300">{me?.email ?? "…"}</span>
          </p>
        </div>

        {status && (
          <div className="flex items-center gap-2 flex-wrap">
            <span
              className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${PLAN_PILL[status.plan]}`}
            >
              {PLAN_LABEL[status.plan]}
            </span>
            {status.founder_member && (
              <span className="rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wider text-violet-300">
                Founder
              </span>
            )}
            {trialDaysLeft !== null && (
              <span
                className={`rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wider ${
                  trialDaysLeft <= 2
                    ? "bg-rose-500/10 border-rose-500/40 text-rose-300"
                    : trialDaysLeft <= 7
                    ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                    : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                }`}
              >
                {trialDaysLeft === 0
                  ? "Trial ends today"
                  : `${trialDaysLeft}d left on trial`}
              </span>
            )}
          </div>
        )}
      </div>

      {/* ─── Locked / trial CTA banner ──────────────────────────────── */}
      {status?.plan === "locked" && <LockedBanner />}
      {status?.is_trialing && trialDaysLeft !== null && trialDaysLeft <= 7 && (
        <TrialEndingBanner days={trialDaysLeft} />
      )}

      {/* ─── Usage strip ────────────────────────────────────────────── */}
      {status && status.plan !== "locked" && (
        <section className="space-y-3">
          <SectionHeader
            title="Usage this month"
            link={{ to: "/app/settings", label: "Plan details →" }}
          />
          <UsageStrip usage={usage} />
        </section>
      )}

      {/* ─── Quick actions ──────────────────────────────────────────── */}
      <section className="space-y-3">
        <SectionHeader title="Get to work" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <DashCard
            to="/app/templates/new"
            title="New template"
            body="Upload Illustrator/PDF, or generate a grid from artboard + shape."
            cta="Create →"
            highlight
          />
          <DashCard
            to="/app/templates"
            title="Templates"
            body="Manage uploaded and generated templates."
          />
          <DashCard
            to="/app/jobs"
            title="Jobs"
            body="Programmed slot orders for a template — reuse across many fills."
          />
          <DashCard
            to="/app/catalogue"
            title="Catalogue"
            body="Categorise your artwork. Import / export bundles to share."
          />
          <DashCard
            to="/app/outputs"
            title="Outputs"
            body="Print-ready PDFs you've generated. Download anytime."
          />
          <DashCard
            to="/app/settings"
            title="Settings"
            body="Profile, colour profiles, plan and billing."
          />
        </div>
      </section>

      {/* ─── Recent outputs ─────────────────────────────────────────── */}
      {recent && recent.length > 0 && (
        <section className="space-y-3">
          <SectionHeader
            title="Recent print-ready PDFs"
            link={{ to: "/app/outputs", label: "View all →" }}
          />
          <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 divide-y divide-neutral-900">
            {recent.map((o) => (
              <RecentRow key={o.id} output={o} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Sub-components
   ───────────────────────────────────────────────────────────────────── */

function SectionHeader({
  title,
  link,
}: {
  title: string;
  link?: { to: string; label: string };
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <h2 className="text-xs uppercase tracking-widest text-neutral-500 font-semibold">
        {title}
      </h2>
      {link && (
        <Link
          to={link.to}
          className="text-xs text-neutral-400 hover:text-white transition"
        >
          {link.label}
        </Link>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────
   Usage strip — single collapsed row on mobile, full 4-card grid on
   desktop. The mobile compact view shows the two cap-bound metrics
   (templates + exports) inline with their progress; tap to expand.
   ───────────────────────────────────────────────────────────────────── */
function UsageStrip({ usage }: { usage: BillingUsage | null }) {
  const [open, setOpen] = useState(false);

  const cards = (
    <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <UsageCard
        label="Templates"
        used={usage?.templates_used ?? null}
        cap={usage?.templates_cap ?? null}
        accent="from-fuchsia-500 to-rose-500"
      />
      <UsageCard
        label="PDF exports / mo"
        used={usage?.exports_this_month ?? null}
        cap={usage?.exports_cap_per_month ?? null}
        accent="from-sky-500 to-indigo-500"
      />
      <StorageCard
        used={usage?.storage_mb_used ?? null}
        cap={usage?.storage_mb_cap ?? null}
      />
      <StatCard
        label="Artwork on file"
        value={usage?.asset_count ?? null}
        accent="from-emerald-400 to-teal-500"
        suffix={
          usage?.asset_size_mb_max
            ? `up to ${usage.asset_size_mb_max} MB / file`
            : "unlimited"
        }
      />
    </div>
  );

  return (
    <>
      {/* Desktop / tablet: always show full grid */}
      <div className="hidden sm:block">{cards}</div>

      {/* Mobile: compact single rectangle, expandable */}
      <div className="sm:hidden">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="w-full rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-left active:bg-neutral-900/60 transition"
        >
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col min-w-0 flex-1">
              <div className="flex items-center gap-3 text-sm">
                <CompactStat
                  label="Templates"
                  used={usage?.templates_used ?? null}
                  cap={usage?.templates_cap ?? null}
                />
                <span className="text-neutral-700">·</span>
                <CompactStat
                  label="Exports"
                  used={usage?.exports_this_month ?? null}
                  cap={usage?.exports_cap_per_month ?? null}
                />
              </div>
              <div className="text-[11px] text-neutral-500 mt-1">
                {open ? "Tap to collapse" : "Tap for full breakdown"}
              </div>
            </div>
            <Chevron open={open} />
          </div>
          {/* Best progress bar to keep one visual anchor in collapsed mode */}
          {!open && usage && (
            <CompactProgress
              used={Math.max(
                usage.templates_cap ? usage.templates_used / Math.max(1, usage.templates_cap) : 0,
                usage.exports_cap_per_month ? usage.exports_this_month / Math.max(1, usage.exports_cap_per_month) : 0
              )}
            />
          )}
        </button>

        {open && <div className="mt-3">{cards}</div>}
      </div>
    </>
  );
}

function CompactStat({
  label,
  used,
  cap,
}: {
  label: string;
  used: number | null;
  cap: number | null;
}) {
  if (used === null) return <span className="text-neutral-600">{label} —</span>;
  const isUnlimited = cap === null;
  const tight = !isUnlimited && cap !== null && used / cap >= 0.8;
  return (
    <span className={tight ? "text-amber-300" : "text-neutral-300"}>
      <span className="text-neutral-500 text-xs uppercase tracking-wider mr-1">
        {label}
      </span>
      <span className="font-semibold tabular-nums">
        {used}
        <span className="text-neutral-600">/</span>
        {isUnlimited ? "∞" : cap}
      </span>
    </span>
  );
}

function CompactProgress({ used }: { used: number }) {
  const pct = Math.min(100, Math.round(used * 100));
  const tight = pct >= 80;
  return (
    <div className="h-1 mt-3 rounded-full bg-neutral-800 overflow-hidden">
      <div
        className={`h-full rounded-full bg-gradient-to-r transition-all ${
          tight
            ? "from-rose-500 to-amber-500"
            : "from-violet-500 to-fuchsia-500"
        }`}
        style={{ width: `${Math.max(2, pct)}%` }}
      />
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 text-neutral-500 transition-transform ${open ? "rotate-180" : ""}`}
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

function UsageCard({
  label,
  used,
  cap,
  accent,
}: {
  label: string;
  used: number | null;
  cap: number | null;
  accent: string;
}) {
  const isLoading = used === null;
  const isUnlimited = cap === null;
  const pct = isUnlimited || !cap ? 0 : Math.min(100, Math.round(((used ?? 0) / cap) * 100));
  const tight = !isUnlimited && pct >= 80;

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tracking-tight">
          {isLoading ? "—" : used}
        </span>
        <span className="text-sm text-neutral-500">
          / {isUnlimited ? "∞" : cap}
        </span>
      </div>
      <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${
            tight ? "from-rose-500 to-amber-500" : accent
          } transition-all`}
          style={{ width: isUnlimited ? "100%" : `${Math.max(2, pct)}%` }}
        />
      </div>
      {tight && (
        <Link
          to="/pricing"
          className="block text-[11px] text-amber-300 hover:text-amber-200 transition"
        >
          Approaching limit — upgrade →
        </Link>
      )}
      {isUnlimited && !isLoading && (
        <div className="text-[11px] text-neutral-500">Unlimited on your plan</div>
      )}
    </div>
  );
}

/**
 * Storage card — renders MB or GB depending on size and plan cap.
 * Uses orange→pink for the bar to visually distinguish from the
 * count-based metrics (templates / exports). Goes amber at 80%.
 */
function StorageCard({
  used,
  cap,
}: {
  used: number | null;
  cap: number | null;
}) {
  const isLoading = used === null;
  const isUnlimited = cap === null;
  const pct =
    isUnlimited || !cap || used === null
      ? 0
      : Math.min(100, Math.round((used / cap) * 100));
  const tight = !isUnlimited && pct >= 80;

  // Show "1.2 GB / 5 GB" when the cap is at least 1 GB, otherwise MB.
  const usedLabel = used === null ? "—" : formatStorage(used);
  const capLabel = cap === null ? "∞" : formatStorage(cap);

  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        Storage
      </div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-2xl font-bold tracking-tight">{usedLabel}</span>
        <span className="text-sm text-neutral-500">/ {capLabel}</span>
      </div>
      <div className="h-1 rounded-full bg-neutral-800 overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${
            tight
              ? "from-rose-500 to-amber-500"
              : "from-pink-500 to-orange-500"
          } transition-all`}
          style={{ width: isUnlimited ? "100%" : `${Math.max(2, pct)}%` }}
        />
      </div>
      {tight && (
        <Link
          to="/pricing"
          className="block text-[11px] text-amber-300 hover:text-amber-200 transition"
        >
          Approaching limit — upgrade →
        </Link>
      )}
      {isUnlimited && !isLoading && (
        <div className="text-[11px] text-neutral-500">Unlimited on your plan</div>
      )}
    </div>
  );
}

function formatStorage(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}

function StatCard({
  label,
  value,
  accent,
  suffix,
}: {
  label: string;
  value: number | null;
  accent: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 space-y-3">
      <div className="text-xs uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div className="text-2xl font-bold tracking-tight">
        {value === null ? "—" : value}
      </div>
      <div className="h-1 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full bg-gradient-to-r ${accent} opacity-40`}
          style={{ width: "100%" }}
        />
      </div>
      {suffix && <div className="text-[11px] text-neutral-500">{suffix}</div>}
    </div>
  );
}

function DashCard({
  to,
  title,
  body,
  cta = "Open →",
  highlight,
}: {
  to: string;
  title: string;
  body: string;
  cta?: string;
  highlight?: boolean;
}) {
  return (
    <Link
      to={to}
      className={`block rounded-xl border p-5 transition group ${
        highlight
          ? "border-violet-500/30 bg-gradient-to-br from-violet-500/10 to-fuchsia-500/5 hover:border-violet-500/60"
          : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-700"
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="font-semibold">{title}</div>
        <span
          className={`text-xs ${
            highlight
              ? "text-violet-300"
              : "text-neutral-500 group-hover:text-neutral-300"
          } transition`}
        >
          {cta}
        </span>
      </div>
      <div className="text-sm text-neutral-400">{body}</div>
    </Link>
  );
}

function RecentRow({ output }: { output: Output }) {
  const date = new Date(output.created_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });
  const sizeMB = (output.file_size / (1024 * 1024)).toFixed(1);
  return (
    <Link
      to={`/app/outputs?highlight=${output.id}`}
      className="flex items-center justify-between gap-4 px-4 py-3 hover:bg-neutral-900/60 transition"
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-neutral-200 truncate">{output.name}</div>
        <div className="text-xs text-neutral-500 mt-0.5">
          {output.slots_filled}/{output.slots_total} slots · {sizeMB} MB
        </div>
      </div>
      <div className="text-xs text-neutral-500 shrink-0">{date}</div>
    </Link>
  );
}

function LockedBanner() {
  return (
    <div className="rounded-2xl border border-rose-500/30 bg-rose-500/5 p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4">
      <div className="flex-1 space-y-1">
        <p className="font-semibold text-rose-200">Your trial has ended</p>
        <p className="text-sm text-rose-200/70">
          Your templates and artwork are all still here. Pick a plan to get
          back to work.
        </p>
      </div>
      <Link
        to="/pricing"
        className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20"
      >
        View plans →
      </Link>
    </div>
  );
}

function TrialEndingBanner({ days }: { days: number }) {
  return (
    <div
      className={`rounded-2xl border p-5 sm:p-6 flex flex-col sm:flex-row items-start sm:items-center gap-4 ${
        days <= 2
          ? "border-rose-500/30 bg-rose-500/5"
          : "border-amber-500/30 bg-amber-500/5"
      }`}
    >
      <div className="flex-1 space-y-1">
        <p
          className={`font-semibold ${
            days <= 2 ? "text-rose-200" : "text-amber-200"
          }`}
        >
          {days === 0
            ? "Your trial ends today"
            : `${days} day${days === 1 ? "" : "s"} left on your trial`}
        </p>
        <p className="text-sm text-neutral-400">
          Subscribe now to keep your templates, artwork, and colour profiles —
          and lock in the Founder rate (50% off forever) before 30 July 2026.
        </p>
      </div>
      <Link
        to="/pricing"
        className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 transition"
      >
        Choose a plan →
      </Link>
    </div>
  );
}
