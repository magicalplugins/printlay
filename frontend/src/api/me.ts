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
  /** Per-user preference toggles. Hydrated from the same /me bootstrap
   *  call so the Dashboard banner and Outputs row line can render the
   *  time-saved estimate on first paint without an extra round-trip.
   *  See `utils/timeSaved.ts` for how the estimate is derived. */
  time_saved_show_enabled: boolean;
  time_saved_setup_minutes: number;
  time_saved_per_slot_seconds: number;
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

/** Partial update for per-user preferences. Any field omitted is
 *  left unchanged on the server. Bounds (0-600) are enforced
 *  server-side; the frontend mirrors them for UX. */
export type PreferencesUpdate = {
  time_saved_show_enabled?: boolean;
  time_saved_setup_minutes?: number;
  time_saved_per_slot_seconds?: number;
};

export const updatePreferences = (payload: PreferencesUpdate) =>
  api<Me>("/api/auth/me/preferences", {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
