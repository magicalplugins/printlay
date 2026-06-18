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
  is_affiliate: boolean;
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
  stripeStatus?: string,
  affiliateOnly = false
) => {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  if (stripeStatus) params.set("stripe_status", stripeStatus);
  if (affiliateOnly) params.set("affiliate", "true");
  return api<AdminUsersPage>(`/api/admin/users?${params.toString()}`);
};

export type DeleteUserResult = {
  ok: boolean;
  email: string;
  deleted_affiliate_profile: boolean;
  supabase_auth_deleted: boolean | null;
  supabase_error: string | null;
};

export const deleteAdminUser = (userId: string) =>
  api<DeleteUserResult>(`/api/admin/users/${userId}`, { method: "DELETE" });

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
  email_provider: "smtp2go" | "resend" | "none";
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

export type UserDetailJob = {
  id: string;
  name: string;
  created_at: string;
  template_id: string;
  slots_filled: number;
  slots_total: number;
  unique_assets: number;
};
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

// ---- Leads (chat widget inbox) ----

export type LeadStatus = "new" | "read" | "responded" | "archived";

export type LeadCategory = "support" | "presales" | "bug_feature" | "general";

export type AdminLead = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
  source: string;
  page_url: string | null;
  user_id: string | null;
  status: LeadStatus;
  category: LeadCategory;
  created_at: string;
};

export type AdminLeadsPage = {
  total: number;
  unread: number;
  items: AdminLead[];
  counts_by_category: Record<LeadCategory, number>;
};

export const getAdminLeads = (
  status?: LeadStatus,
  category?: LeadCategory | null,
  limit = 100,
  offset = 0
) => {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (category) params.set("category", category);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return api<AdminLeadsPage>(`/api/admin/leads?${params.toString()}`);
};

export const getLeadsUnreadCount = () =>
  api<{ unread: number }>("/api/admin/leads/unread-count");

export const patchLeadStatus = (id: string, status: LeadStatus) =>
  api<AdminLead>(`/api/admin/leads/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });

// ---- Trial invites (admin-issued extended trials) ----

export type InviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type AdminInvite = {
  id: string;
  email: string;
  trial_days: number;
  note: string | null;
  token: string;
  invite_url: string;
  invited_by_email: string | null;
  created_at: string;
  expires_at: string;
  sent_at: string | null;
  accepted_at: string | null;
  accepted_user_id: string | null;
  revoked_at: string | null;
  status: InviteStatus;
  affiliate_label: string | null;
};

export type AdminInvitesPage = {
  total: number;
  items: AdminInvite[];
};

export type CreateInvitePayload = {
  email: string;
  trial_days: number;
  note?: string | null;
};

export type InviteSendResult = {
  invite: AdminInvite;
  sent: boolean;
  send_error: string | null;
};

export const getAdminInvites = (status?: InviteStatus) => {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  return api<AdminInvitesPage>(`/api/admin/invites?${params.toString()}`);
};

export const createAdminInvite = (payload: CreateInvitePayload) =>
  api<InviteSendResult>("/api/admin/invites", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const resendAdminInvite = (id: string) =>
  api<InviteSendResult>(`/api/admin/invites/${id}/resend`, { method: "POST" });

export const revokeAdminInvite = (id: string, revoke: boolean) =>
  api<AdminInvite>(`/api/admin/invites/${id}/revoke`, {
    method: "POST",
    body: JSON.stringify({ revoke }),
  });

export const getInvitesPendingCount = () =>
  api<{ pending: number }>("/api/admin/invites/pending-count");

// ---- Integrations (third-party credentials) ----

export type IntegrationSetting = {
  key: string;
  is_set: boolean;
  source: "db" | "env" | "none";
  updated_at: string | null;
  updated_by_email: string | null;
};

export type IntegrationsResponse = {
  encryption_available: boolean;
  email_provider: "smtp2go" | "resend" | "none";
  email_configured: boolean;
  sms_configured: boolean;
  settings: IntegrationSetting[];
};

export type IntegrationTestResult = {
  ok: boolean;
  error: string | null;
  provider: string | null;
};

export const getIntegrations = () =>
  api<IntegrationsResponse>("/api/admin/integrations");

export const setIntegration = (key: string, value: string) =>
  api<IntegrationsResponse>("/api/admin/integrations", {
    method: "PUT",
    body: JSON.stringify({ key, value }),
  });

export const testIntegration = (
  channel: "email" | "sms",
  recipient: string
) =>
  api<IntegrationTestResult>("/api/admin/integrations/test", {
    method: "POST",
    body: JSON.stringify({ channel, recipient }),
  });

export type CloneJobResult = {
  job_id: string;
  template_id: string;
  assets_cloned: number;
  message: string;
};

export const cloneJobToAdmin = (userId: string, jobId: string) =>
  api<CloneJobResult>(`/api/admin/users/${userId}/jobs/${jobId}/clone`, {
    method: "POST",
  });
