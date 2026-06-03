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
  /** True when the user has stored an OpenAI API key (for AI image
   *  styles). The key itself is never sent to the client. */
  openai_key_set: boolean;
};

/** Fetch the calling user's app profile. If `inviteToken` is provided
 *  and this is the user's very first call (i.e. they're being
 *  provisioned), the backend will honour it and grant the longer trial
 *  baked into the invite. Subsequent calls ignore the token.
 *  Similarly, `affiliateRef` is passed for first-provision attribution. */
export const getMe = (inviteToken?: string | null, affiliateRef?: string | null) => {
  const params = new URLSearchParams();
  if (inviteToken) params.set("invite", inviteToken);
  if (affiliateRef) params.set("ref", affiliateRef);
  const qs = params.toString() ? `?${params.toString()}` : "";
  return api<Me>(`/api/auth/me${qs}`);
};

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

/** Store the user's own OpenAI API key (used for AI image styles).
 *  Stored encrypted server-side; never returned. Pass an empty string
 *  to clear it. */
export const setOpenAIKey = (apiKey: string) =>
  api<Me>("/api/auth/me/openai-key", {
    method: "PUT",
    body: JSON.stringify({ api_key: apiKey }),
  });

export const clearOpenAIKey = () =>
  api<Me>("/api/auth/me/openai-key", { method: "DELETE" });
