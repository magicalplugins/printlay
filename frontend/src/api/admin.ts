import { api } from "./client";

export type TierCount = { tier: string; count: number };
export type StatusCount = { status: string; count: number };
export type TimeSeriesPoint = { date: string; count: number };

export type StatsSummary = {
  users_total: number;
  users_signups_24h: number;
  users_signups_7d: number;
  users_signups_30d: number;
  users_active_30d: number;
  pdfs_total: number;
  pdfs_24h: number;
  pdfs_7d: number;
  pdfs_30d: number;
  jobs_total: number;
  templates_total: number;
  assets_total: number;
  storage_bytes: number;
  // Billing
  active_subscribers: number;
  trialing_users: number;
  locked_users: number;
  past_due_users: number;
  founder_members: number;
  pdfs_per_day_30d: TimeSeriesPoint[];
  signups_per_day_30d: TimeSeriesPoint[];
  tiers: TierCount[];
  subscription_statuses: StatusCount[];
};

export type ActiveUserRow = {
  id: string;
  email: string;
  company_name: string | null;
  tier: string;
  stripe_subscription_status: string | null;
  jobs_30d: number;
  pdfs_30d: number;
  last_pdf_at: string | null;
};

export type SubscriberRow = {
  id: string;
  email: string;
  company_name: string | null;
  tier: string;
  plan: string;
  stripe_subscription_status: string;
  stripe_current_period_end: string | null;
  founder_member: boolean;
};

export type DropoutRow = {
  id: string;
  email: string;
  company_name: string | null;
  plan: string;
  trial_ends_at: string | null;
  reason:
    | "trial_expired"
    | "canceled"
    | "past_due"
    | "stuck_signup"
    | "stuck_template";
  last_active_at: string | null;
};

export type AdminUserRow = {
  id: string;
  email: string;
  phone: string | null;
  company_name: string | null;
  tier: string;
  plan: string;
  stripe_subscription_status: string | null;
  stripe_current_period_end: string | null;
  trial_ends_at: string | null;
  founder_member: boolean;
  created_at: string;
  is_active: boolean;
  jobs_total: number;
  pdfs_total: number;
};

export type AdminUsersPage = {
  total: number;
  items: AdminUserRow[];
};

export const getAdminStats = () => api<StatsSummary>("/api/admin/stats");
export const getActiveUsers = (limit = 20) =>
  api<ActiveUserRow[]>(`/api/admin/users/active?limit=${limit}`);
export const getSubscribers = () =>
  api<SubscriberRow[]>("/api/admin/users/subscribers");
export const getDropouts = () => api<DropoutRow[]>("/api/admin/users/dropouts");
export const getAdminUsers = (
  q?: string,
  limit = 50,
  offset = 0,
  stripeStatus?: string
) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (stripeStatus) params.set("stripe_status", stripeStatus);
  return api<AdminUsersPage>(`/api/admin/users?${params.toString()}`);
};

// ---- Bulk messaging ----

export type Segment =
  | "all"
  | "active_subscribers"
  | "trialing"
  | "dropouts"
  | "most_active_30d"
  | "stuck_signup"
  | "stuck_template"
  | "expiring_30d";

export type MessageRequest = {
  segment: Segment;
  channel: "email" | "sms";
  subject?: string;
  body: string;
  html_body?: string | null;
  dry_run?: boolean;
  limit?: number;
};

export type MessageResultItem = {
  recipient: string;
  ok: boolean;
  error: string | null;
};

export type MessageResponse = {
  segment: Segment;
  channel: string;
  recipients_total: number;
  sent: number;
  failed: number;
  dry_run: boolean;
  results: MessageResultItem[];
};

export type MessagingStatus = {
  email_configured: boolean;
  sms_configured: boolean;
};

export const sendAdminMessage = (req: MessageRequest) =>
  api<MessageResponse>("/api/admin/messages", {
    method: "POST",
    body: JSON.stringify(req),
  });

export const getMessagingStatus = () =>
  api<MessagingStatus>("/api/admin/messaging/status");

// ---- Stripe billing diagnostics ----

export type BillingHealth = {
  fully_configured: boolean;
  items: {
    secret_key: boolean;
    webhook_secret: boolean;
    price_starter_monthly: boolean;
    price_starter_annual: boolean;
    price_pro_monthly: boolean;
    price_pro_annual: boolean;
    price_studio_monthly: boolean;
    price_studio_annual: boolean;
  };
};

export const getBillingHealth = () =>
  api<BillingHealth>("/api/admin/billing/health");

// ---- Per-user detail ----

export type UserDetailJob = { id: string; name: string; created_at: string };
export type UserDetailOutput = {
  id: string;
  name: string;
  file_size: number;
  slots_filled: number;
  slots_total: number;
  created_at: string;
};
export type UserDetailCatalogue = {
  id: string;
  name: string;
  subscribed_at: string;
  is_official: boolean;
};

export type UserDetail = {
  id: string;
  email: string;
  phone: string | null;
  company_name: string | null;
  tier: string;
  plan: string;
  stripe_subscription_status: string | null;
  stripe_subscription_id: string | null;
  stripe_customer_id: string | null;
  stripe_price_id: string | null;
  stripe_current_period_end: string | null;
  trial_ends_at: string | null;
  founder_member: boolean;
  is_active: boolean;
  created_at: string;
  counts: {
    jobs_total: number;
    pdfs_total: number;
    pdfs_30d: number;
    pdfs_7d: number;
    templates_total: number;
    asset_count: number;
    storage_bytes: number;
  };
  last_pdf_at: string | null;
  last_job_at: string | null;
  recent_jobs: UserDetailJob[];
  recent_outputs: UserDetailOutput[];
  catalogue_subscriptions: UserDetailCatalogue[];
};

export const getUserDetail = (userId: string) =>
  api<UserDetail>(`/api/admin/users/${userId}`);

export type UserPatch = {
  tier?: "locked" | "starter" | "pro" | "studio" | "enterprise";
  founder_member?: boolean;
  is_active?: boolean;
};

export const patchAdminUser = (userId: string, patch: UserPatch) =>
  api<{ ok: boolean; changes: Record<string, unknown>; plan?: string }>(
    `/api/admin/users/${userId}`,
    { method: "PATCH", body: JSON.stringify(patch) }
  );
