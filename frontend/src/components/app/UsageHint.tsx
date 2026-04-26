import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { BillingUsage, getBillingUsage } from "../../api/billing";

type Metric =
  | "templates"
  | "exports_this_month"
  | "jobs"
  | "assets"
  | "storage"
  | "categories"
  | "color_profiles";

type Props = {
  metric: Metric;
  /** Singular noun shown after the count, e.g. "template", "export". */
  noun?: string;
};

/**
 * Tiny, low-noise inline usage hint for list-page headers.
 *
 *   "12 / 50 templates · Pro"
 *
 * - Renders nothing while loading, so headers don't jiggle.
 * - Shows "X / Unlimited" for unlimited tiers.
 * - Goes amber once usage is >=80% of the cap.
 * - Clickable → /app/settings (where the full breakdown lives).
 *
 * Keep it small. The Dashboard does the heavy lifting; here we just want
 * a glanceable reminder so users on Starter don't get surprised.
 */
export default function UsageHint({ metric, noun }: Props) {
  const [usage, setUsage] = useState<BillingUsage | null>(null);

  useEffect(() => {
    getBillingUsage().then(setUsage).catch(() => setUsage(null));
  }, []);

  if (!usage) return null;

  const { used, cap, label } = pickMetric(usage, metric, noun);
  if (used === null) return null;

  const isUnlimited = cap === null;
  const pct = isUnlimited || !cap ? 0 : (used / cap) * 100;
  const tight = !isUnlimited && pct >= 80;

  const tone = tight
    ? "border-amber-500/40 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15"
    : "border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700";

  // Storage gets a custom display ("1.2 / 5 GB") instead of plain numbers.
  const usedLabel =
    metric === "storage" ? formatStorage(used) : String(used);
  const capLabel =
    metric === "storage" && cap !== null
      ? formatStorage(cap)
      : isUnlimited
      ? "∞"
      : String(cap);

  return (
    <Link
      to="/app/settings"
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition ${tone}`}
      title="View plan & usage"
    >
      <span className="font-semibold tabular-nums">
        {usedLabel}
        <span className="text-neutral-500">/</span>
        {capLabel}
      </span>
      <span className="hidden sm:inline opacity-70">{label}</span>
    </Link>
  );
}

function pickMetric(
  usage: BillingUsage,
  metric: Metric,
  noun?: string
): { used: number | null; cap: number | null; label: string } {
  switch (metric) {
    case "templates":
      return {
        used: usage.templates_used,
        cap: usage.templates_cap,
        label: noun ?? "templates",
      };
    case "exports_this_month":
      return {
        used: usage.exports_this_month,
        cap: usage.exports_cap_per_month,
        label: noun ?? "exports / mo",
      };
    case "jobs":
      // Jobs aren't capped — but we still surface the count for context.
      return { used: usage.jobs_total, cap: null, label: noun ?? "jobs" };
    case "assets":
      return { used: usage.asset_count, cap: null, label: noun ?? "assets" };
    case "storage":
      return {
        used: usage.storage_mb_used,
        cap: usage.storage_mb_cap,
        label: noun ?? "storage",
      };
    case "categories":
      return {
        used: usage.categories_used,
        cap: usage.categories_cap,
        label: noun ?? "categories",
      };
    case "color_profiles":
      return {
        used: usage.color_profiles_used,
        cap: usage.color_profiles_cap,
        label: noun ?? "colour profiles",
      };
  }
}

function formatStorage(mb: number): string {
  if (mb >= 1024) {
    const gb = mb / 1024;
    return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`;
  }
  return `${Math.round(mb)} MB`;
}
