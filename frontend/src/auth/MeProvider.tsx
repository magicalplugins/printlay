import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { forgetInviteToken, recallInviteToken } from "../api/invites";
import { getMe, Me } from "../api/me";
import { useAuth } from "./AuthProvider";

type MeState = {
  me: Me | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setMe: (m: Me) => void;
};

const MeContext = createContext<MeState | null>(null);

/** Loads the calling user's app-side profile (tier, admin flag, profile-gate
 *  status, etc.) once after the Supabase session is ready, and re-fetches it
 *  whenever that session changes. Components consume it via {@link useMe}. */
export function MeProvider({ children }: { children: ReactNode }) {
  const { ready, session } = useAuth();
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep a ref to the current session so `refresh` can read it without
  // depending on the session object itself. Supabase fires multiple
  // onAuthStateChange events (SIGNED_IN, TOKEN_REFRESHED, etc.) during
  // the email-confirmation redirect flow, each creating a new Session
  // object. If `refresh` depended on [session] directly, every new
  // reference would recreate the callback, re-trigger the useEffect,
  // and hammer /api/auth/me in a tight loop until the token dies.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refresh = useCallback(async () => {
    if (!sessionRef.current) {
      setMe(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const token = recallInviteToken();
      const affiliateRef = localStorage.getItem("printlay.ref");
      const m = await getMe(token, affiliateRef);
      if (token) forgetInviteToken();
      if (affiliateRef) localStorage.removeItem("printlay.ref");
      setMe(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Only re-fetch when the auth state actually transitions (signed-in
  // ↔ signed-out), not on every Supabase token refresh.
  const hasSession = !!session;
  useEffect(() => {
    if (!ready) return;
    refresh();
  }, [ready, hasSession, refresh]);

  const value = useMemo<MeState>(
    () => ({ me, loading, error, refresh, setMe }),
    [me, loading, error, refresh]
  );

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe() {
  const ctx = useContext(MeContext);
  if (!ctx) throw new Error("useMe must be used inside <MeProvider>");
  return ctx;
}
