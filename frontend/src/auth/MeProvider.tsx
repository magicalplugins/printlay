import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
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

  const refresh = useCallback(async () => {
    if (!session) {
      setMe(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const m = await getMe();
      setMe(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    if (!ready) return;
    refresh();
  }, [ready, refresh]);

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
