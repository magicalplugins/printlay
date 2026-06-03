import { api } from "./client";

export type AffiliateDashboard = {
  ref_code: string;
  status: string;
  commission_rate: number;
  pending_balance_pence: number;
  total_earned_pence: number;
  total_paid_pence: number;
  min_payout_threshold_pence: number;
  stripe_connect_onboarding_complete: boolean;
  total_clicks: number;
  total_conversions: number;
  recent_clicks_30d: number;
  conversion_rate: number;
};

export type AffiliateClick = {
  clicked_at: string;
  landing_path: string | null;
  converted: boolean;
};

export type AffiliateConversion = {
  converted_at: string;
  commission_pence: number;
  status: string;
  stripe_charge_amount_pence: number;
};

export type AffiliateListItem = {
  id: string;
  email: string;
  name: string | null;
  ref_code: string;
  status: string;
  commission_rate: number;
  pending_balance_pence: number;
  total_earned_pence: number;
  total_paid_pence: number;
  stripe_connect_onboarding_complete: boolean;
  total_clicks: number;
  total_conversions: number;
  created_at: string;
};

export type AdminOverview = {
  total_affiliates: number;
  active_affiliates: number;
  total_clicks: number;
  total_conversions: number;
  total_commission_pence: number;
  total_paid_pence: number;
  pending_balance_pence: number;
};

export type PayoutItem = {
  id: string;
  affiliate_id: string;
  amount_pence: number;
  status: string;
  stripe_transfer_id: string | null;
  period_start: string;
  period_end: string;
  paid_at: string | null;
  created_at: string;
};

// ---- Authenticated user endpoints ----

export const getDashboard = () =>
  api<AffiliateDashboard>("/api/affiliate/dashboard");

export const joinAsAffiliate = () =>
  api<{ ref_code: string; message: string }>("/api/affiliate/join", {
    method: "POST",
  });

export const getClicks = (limit = 50) =>
  api<AffiliateClick[]>(`/api/affiliate/clicks?limit=${limit}`);

export const getConversions = (limit = 50) =>
  api<AffiliateConversion[]>(`/api/affiliate/conversions?limit=${limit}`);

export const startConnectOnboarding = () =>
  api<{ url: string }>("/api/affiliate/connect/onboard", { method: "POST" });

export const checkConnectStatus = () =>
  api<{ onboarding_complete: boolean }>("/api/affiliate/connect/check", {
    method: "POST",
  });

export const getConnectLoginLink = () =>
  api<{ url: string }>("/api/affiliate/connect/login-link");

// ---- Public (no auth) ----

export const affiliateSignup = (email: string, name?: string) =>
  api<{ ref_code: string; message: string }>("/api/affiliate/signup", {
    method: "POST",
    body: JSON.stringify({ email, name }),
  });

// ---- Admin endpoints ----

export const getAdminOverview = () =>
  api<AdminOverview>("/api/admin/affiliate/overview");

export const getAdminAffiliateList = (statusFilter?: string) => {
  const qs = statusFilter ? `?status=${statusFilter}` : "";
  return api<AffiliateListItem[]>(`/api/admin/affiliate/list${qs}`);
};

export const updateAffiliate = (
  id: string,
  body: { status?: string; commission_rate?: number; min_payout_threshold_pence?: number }
) =>
  api<{ ok: boolean }>(`/api/admin/affiliate/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const overrideConversion = (conversionId: string, status: string) =>
  api<{ ok: boolean; new_status: string }>(
    `/api/admin/affiliate/conversions/${conversionId}/override`,
    { method: "POST", body: JSON.stringify({ status }) }
  );

export const runPayouts = () =>
  api<{ results: unknown[]; conversions_approved: number }>(
    "/api/admin/affiliate/payouts/run",
    { method: "POST" }
  );

export const getPayouts = (limit = 50) =>
  api<PayoutItem[]>(`/api/admin/affiliate/payouts?limit=${limit}`);
