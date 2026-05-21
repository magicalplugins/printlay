import { api } from "./client";

export type InviteInfo = {
  email: string;
  trial_days: number;
};

/** Public lookup for the Register page. Returns 404 for any
 *  non-claimable state (revoked, expired, accepted, missing). */
export const getInviteInfo = (token: string) =>
  api<InviteInfo>(`/api/invites/${encodeURIComponent(token)}`);

const STORAGE_KEY = "printlay.inviteToken";

/** The invite token has to survive Supabase's email-confirm round trip
 *  (when "Confirm email" is enabled in Supabase). sessionStorage is the
 *  sweet spot — survives an in-tab redirect but gone the next day. */
export function rememberInviteToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    /* sessionStorage may be unavailable in private mode — fall back to
     * the URL-query path; nothing else to do here. */
  }
}

export function recallInviteToken(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function forgetInviteToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* noop */
  }
}
