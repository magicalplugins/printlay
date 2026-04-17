import { createClient, SupabaseClient } from "@supabase/supabase-js";

type PublicConfig = {
  supabase_url: string | null;
  supabase_anon_key: string | null;
  environment: string;
};

let _clientPromise: Promise<SupabaseClient> | null = null;
let _config: PublicConfig | null = null;

async function fetchConfig(): Promise<PublicConfig> {
  const res = await fetch("/api/config");
  if (!res.ok) throw new Error(`config fetch failed: ${res.status}`);
  return res.json();
}

export async function getPublicConfig(): Promise<PublicConfig> {
  if (_config) return _config;
  _config = await fetchConfig();
  return _config;
}

export async function getSupabase(): Promise<SupabaseClient> {
  if (_clientPromise) return _clientPromise;
  _clientPromise = (async () => {
    const cfg = await getPublicConfig();
    if (!cfg.supabase_url || !cfg.supabase_anon_key) {
      throw new Error(
        "Supabase is not configured on the server. Set SUPABASE_URL + SUPABASE_ANON_KEY via fly secrets."
      );
    }
    return createClient(cfg.supabase_url, cfg.supabase_anon_key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    });
  })();
  return _clientPromise;
}
