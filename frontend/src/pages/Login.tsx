import { FormEvent, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Login() {
  const { client, configError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? "/app";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setBusy(true);
    setErr(null);
    const { error } = await client.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    navigate(from, { replace: true });
  }

  async function onGoogle() {
    if (!client) return;
    await client.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin + "/app" },
    });
  }

  return (
    <main className="min-h-full flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <Link to="/" className="text-xs uppercase tracking-widest text-neutral-500">
            Printlay
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Welcome back</h1>
        </div>

        {configError && (
          <div className="rounded-lg border border-rose-900/50 bg-rose-950/30 p-3 text-sm text-rose-300">
            Auth is not configured: {configError}
          </div>
        )}

        <form onSubmit={onSubmit} className="space-y-4">
          <input
            type="email"
            required
            placeholder="you@studio.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 outline-none focus:border-neutral-600"
          />
          <input
            type="password"
            required
            minLength={8}
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 outline-none focus:border-neutral-600"
          />
          {err && <div className="text-sm text-rose-400">{err}</div>}
          <button
            type="submit"
            disabled={busy || !client}
            className="w-full rounded-lg bg-white px-4 py-3 font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <div className="flex items-center gap-3 text-xs text-neutral-500">
          <div className="h-px flex-1 bg-neutral-800" />
          or
          <div className="h-px flex-1 bg-neutral-800" />
        </div>

        <button
          onClick={onGoogle}
          disabled={!client}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 font-medium hover:border-neutral-600 disabled:opacity-40"
        >
          Continue with Google
        </button>

        <p className="text-center text-sm text-neutral-400">
          New here?{" "}
          <Link to="/register" className="text-white underline underline-offset-4">
            Create an account
          </Link>
        </p>
      </div>
    </main>
  );
}
