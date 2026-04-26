import { api } from "./client";

export type Plan = "starter" | "pro" | "studio" | "enterprise" | "locked";

export type BillingStatus = {
  plan: Plan;
  is_trialing: boolean;
  limits: Record<string, number | null>;
  features: string[];
  trial_ends_at: string | null;
  stripe_subscription_status: string | null;
  stripe_current_period_end: string | null;
  founder_member: boolean;
};

export function getBillingStatus() {
  return api<BillingStatus>("/api/billing/status");
}

// ---- Usage ----
export type BillingUsage = {
  templates_used: number;
  templates_cap: number | null;
  exports_this_month: number;
  exports_cap_per_month: number | null;
  jobs_total: number;
  asset_count: number;
  asset_size_mb_max: number | null;
  /** Total stored artwork — catalogue + job uploads. Excludes generated outputs. */
  storage_mb_used: number;
  /** Plan storage cap in MB. `null` = unlimited. */
  storage_mb_cap: number | null;
  /** Owned categories (subscribed officials don't count toward the cap). */
  categories_used: number;
  categories_cap: number | null;
  color_profiles_used: number;
  color_profiles_cap: number | null;
  last_export_at: string | null;
  period_start: string;
};

export function getBillingUsage() {
  return api<BillingUsage>("/api/billing/usage");
}

// ---- Plans catalogue (used by /pricing) ----
export type PlanItem = {
  id: "starter" | "pro" | "studio";
  name: string;
  monthly_price_id: string | null;
  annual_price_id: string | null;
  monthly_price_display: string;
  annual_price_display: string;
  annual_save_pct: number;
  tagline: string;
  features: string[];
  most_popular: boolean;
};

export type PlansResponse = {
  plans: PlanItem[];
  enterprise_contact_email: string;
  founder_seats_remaining: number | null;
};

export function getPlans() {
  return api<PlansResponse>("/api/billing/plans");
}

// ---- Checkout ----
export function startCheckout(opts: {
  price_id: string;
  success_url: string;
  cancel_url: string;
  coupon?: string | null;
}) {
  return api<{ url: string }>("/api/billing/checkout", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

// ---- Customer Portal ----
export function openCustomerPortal(opts: { return_url: string }) {
  return api<{ url: string }>("/api/billing/portal", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

// ---- Change plan (modify an existing subscription) ----
//
// Use this — *not* startCheckout — when the user already has a live
// Stripe subscription. It opens a Customer Portal session pre-filled
// to confirm switching them to the new price (Stripe shows the
// proration breakdown and a single "Confirm change" button).
//
// Calling startCheckout for an already-subscribed user is a 409 from
// the backend; this function is the right way out of that.
export function changePlan(opts: { price_id: string; return_url: string }) {
  return api<{ url: string }>("/api/billing/change-plan", {
    method: "POST",
    body: JSON.stringify(opts),
  });
}
