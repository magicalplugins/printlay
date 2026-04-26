import { api } from "./client";

export type Me = {
  id: string;
  auth_id: string;
  email: string;
  tier: string;
  is_active: boolean;
  created_at: string;
  trial_ends_at: string | null;
  stripe_subscription_status: string | null;
  stripe_price_id: string | null;
  founder_member: boolean;
  phone: string | null;
  company_name: string | null;
  needs_profile: boolean;
  is_admin: boolean;
};

export const getMe = () => api<Me>("/api/auth/me");

export type ProfileUpdate = {
  phone: string;
  company_name?: string | null;
};

export const updateProfile = (payload: ProfileUpdate) =>
  api<Me>("/api/auth/me/profile", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
