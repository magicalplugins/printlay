import { FormEvent, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";

export default function SignupBlock() {
  const { client } = useAuth();
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
      setInfo("Check your inbox to confirm your email.");
    }
  }

  return (
    <section className="px-6 py-32 border-t border-neutral-900">
      <div className="max-w-2xl mx-auto text-center space-y-10">
        <div className="space-y-3">
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight">
            Stop dragging.
            <br />
            <span className="italic font-light">Start printing.</span>
          </h2>
          <p className="text-neutral-400 text-lg">
            14-day full-access trial. No card required to start.
            <br />
            Pick a plan when you're ready — or lock in the Founder rate (50% off forever) before 30 July 2026.
          </p>
        </div>

        <form onSubmit={onSubmit} className="space-y-3 text-left">
          <div className="grid sm:grid-cols-2 gap-3">
            <input
              type="email"
              required
              placeholder="you@studio.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3.5 outline-none focus:border-neutral-600"
            />
            <input
              type="password"
              required
              minLength={8}
              placeholder="Password (min 8)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900 px-4 py-3.5 outline-none focus:border-neutral-600"
            />
          </div>
          {err && <div className="text-sm text-rose-400">{err}</div>}
          {info && <div className="text-sm text-emerald-400">{info}</div>}
          <button
            type="submit"
            disabled={busy || !client}
            className="w-full rounded-xl bg-white px-6 py-4 text-lg font-semibold text-neutral-950 hover:bg-neutral-200 transition disabled:opacity-40"
          >
            {busy ? "Creating…" : "Start 14-day trial →"}
          </button>
          <p className="text-center text-xs text-neutral-500">
            By starting a trial you agree to our{" "}
            <Link
              to="/terms"
              className="underline underline-offset-2 hover:text-neutral-300"
            >
              terms
            </Link>
            .
          </p>
        </form>

        <div className="flex flex-col items-center gap-2">
          <p className="text-center text-sm text-neutral-500">
            Already have an account?{" "}
            <Link to="/login" className="text-white underline underline-offset-4">
              Sign in
            </Link>
          </p>
          <Link
            to="/pricing"
            className="text-sm text-neutral-500 hover:text-neutral-300 underline underline-offset-4 transition"
          >
            View pricing →
          </Link>
        </div>
      </div>
    </section>
  );
}
