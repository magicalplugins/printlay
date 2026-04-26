import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

export default function Register() {
  const { client, configError } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + "/app" },
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    if (data.session) {
      navigate("/app", { replace: true });
    } else {
      setInfo(
        "Check your inbox to confirm your email, then sign in. (You can disable this in Supabase Authentication → Providers → Email if you'd rather skip verification during build.)"
      );
    }
  }

  return (
    <main className="min-h-full flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <Link to="/" className="text-xs uppercase tracking-widest text-neutral-500">
            Printlay
          </Link>
          <h1 className="text-3xl font-bold tracking-tight">Start your free trial</h1>
          <p className="text-sm text-neutral-400">14 days full access · No card required to start</p>
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
            placeholder="Password (min 8)"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 outline-none focus:border-neutral-600"
          />
          {err && <div className="text-sm text-rose-400">{err}</div>}
          {info && <div className="text-sm text-emerald-400">{info}</div>}
          <button
            type="submit"
            disabled={busy || !client}
            className="w-full rounded-lg bg-white px-4 py-3 font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
          >
            {busy ? "Creating…" : "Start 14-day trial →"}
          </button>

          <p className="text-xs text-neutral-500 leading-relaxed">
            By creating an account you agree to our{" "}
            <Link
              to="/terms"
              className="underline underline-offset-2 hover:text-neutral-300"
            >
              Terms &amp; Conditions
            </Link>
            . Founder Offer subscribers receive a 50% percentage discount
            off the published price at each renewal — see §6 of the terms
            for the full detail.
          </p>
        </form>

        <div className="space-y-2 text-center">
          <p className="text-sm text-neutral-400">
            Already have an account?{" "}
            <Link to="/login" className="text-white underline underline-offset-4">
              Sign in
            </Link>
          </p>
          <Link
            to="/pricing"
            className="block text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-4 transition"
          >
            View pricing →
          </Link>
        </div>
      </div>
    </main>
  );
}
