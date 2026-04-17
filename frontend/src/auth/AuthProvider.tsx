import {
  createContext,
  ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabase";

type AuthState = {
  ready: boolean;
  client: SupabaseClient | null;
  session: Session | null;
  configError: string | null;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    (async () => {
      try {
        const sb = await getSupabase();
        if (cancelled) return;
        setClient(sb);
        const { data } = await sb.auth.getSession();
        if (cancelled) return;
        setSession(data.session);

        const sub = sb.auth.onAuthStateChange((_event, s) => {
          setSession(s);
        });
        unsubscribe = () => sub.data.subscription.unsubscribe();
      } catch (err) {
        if (!cancelled) setConfigError(String(err));
      } finally {
        if (!cancelled) setReady(true);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      ready,
      client,
      session,
      configError,
      signOut: async () => {
        await client?.auth.signOut();
      },
    }),
    [ready, client, session, configError]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
