import { FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import {
  InviteInfo,
  getInviteInfo,
  rememberInviteToken,
} from "../api/invites";

type InviteState =
  | { kind: "none" }
  | { kind: "checking"; token: string }
  | { kind: "invalid"; token: string; reason: string }
  | { kind: "valid"; token: string; info: InviteInfo };

export default function Register() {
  const { client, configError } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const inviteToken = searchParams.get("invite");
  const refCode = searchParams.get("ref");
  // Ghost/affiliate partners arrive via the welcome email with ?partner=1.
  // Their account is created locked (no product trial), so we swap the
  // "free trial" copy for partner-account setup and land them on their
  // affiliate dashboard afterwards.
  const isPartner = searchParams.get("partner") === "1";

  // Persist affiliate ref code for attribution during provisioning
  useEffect(() => {
    if (refCode) localStorage.setItem("printlay.ref", refCode);
  }, [refCode]);

  const [invite, setInvite] = useState<InviteState>(
    inviteToken ? { kind: "checking", token: inviteToken } : { kind: "none" }
  );

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Resolve the invite token once on mount so we can pre-fill the email
  // and show the special hero. Failure is non-blocking — the user can
  // still sign up via the normal 7-day trial flow.
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    (async () => {
      try {
        const result = await getInviteInfo(inviteToken);
        if (cancelled) return;
        setInvite({ kind: "valid", token: inviteToken, info: result });
        setEmail(result.email);
        // Persist for the post-Supabase-signup /me call.
        rememberInviteToken(inviteToken);
      } catch (e) {
        if (cancelled) return;
        setInvite({
          kind: "invalid",
          token: inviteToken,
          reason: String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!client) return;
    setBusy(true);
    setErr(null);
    setInfo(null);
    // Carry the invite through the email-confirmation redirect, if any.
    // Partners land on their affiliate dashboard instead of the (locked)
    // product area.
    const landing = isPartner ? "/app/affiliate" : "/app";
    const redirectQuery =
      invite.kind === "valid" ? `?invite=${invite.token}` : "";
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin + landing + redirectQuery,
      },
    });
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    if (data.session) {
      navigate(landing, { replace: true });
    } else {
      setInfo(
        invite.kind === "valid"
          ? "Almost there — check your inbox to confirm your email, then sign in to claim your trial."
          : isPartner
            ? "Almost there — check your inbox to confirm your email, then sign in to reach your partner dashboard."
            : "Check your inbox to confirm your email, then sign in. (You can disable this in Supabase Authentication → Providers → Email if you'd rather skip verification during build.)"
      );
    }
  }

  const isInvited = invite.kind === "valid";

  return (
    <main className="min-h-full flex items-center justify-center px-6 py-16">
      <div className="w-full max-w-sm space-y-8">
        {isInvited ? (
          <InvitedHero days={invite.info.trial_days} />
        ) : isPartner ? (
          <div className="text-center space-y-2">
            <Link
              to="/"
              className="text-xs uppercase tracking-widest text-neutral-500"
            >
              Printlay · Partner programme
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">
              Set up your partner account
            </h1>
            <p className="text-sm text-neutral-400">
              Create a login to access your partner dashboard, share link and trial invites.
            </p>
          </div>
        ) : (
          <div className="text-center space-y-2">
            <Link
              to="/"
              className="text-xs uppercase tracking-widest text-neutral-500"
            >
              Printlay
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">
              Start your free trial
            </h1>
            <p className="text-sm text-neutral-400">
              7 days full access · No card required to start
            </p>
          </div>
        )}

        {invite.kind === "checking" && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-3 text-xs text-neutral-400 text-center">
            Checking your invite…
          </div>
        )}

        {invite.kind === "invalid" && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200 text-center">
            Your invite link couldn't be verified — it may have expired or
            already been used. You can still sign up with the standard
            7-day trial.
          </div>
        )}

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
            readOnly={isInvited}
            className={`w-full rounded-lg border px-4 py-3 outline-none focus:border-neutral-600 ${
              isInvited
                ? "border-violet-500/30 bg-violet-500/[0.04] text-neutral-200 cursor-not-allowed"
                : "border-neutral-800 bg-neutral-900"
            }`}
          />
          {isInvited && (
            <p className="-mt-2 text-[10px] text-neutral-500">
              This invite is tied to <span className="text-neutral-300">{email}</span>.
            </p>
          )}
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
            className={`w-full rounded-lg px-4 py-3 font-semibold disabled:opacity-40 transition ${
              isInvited || isPartner
                ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400"
                : "bg-white text-neutral-950 hover:bg-neutral-200"
            }`}
          >
            {busy
              ? "Creating…"
              : isInvited
                ? `Claim my ${invite.info.trial_days}-day trial →`
                : isPartner
                  ? "Create partner account →"
                  : "Start 7-day trial →"}
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

/* Special hero for an invited signup. The gradient + "personally
   invited" framing is what makes this feel different from the public
   register page — same brand language as the invite email. */
function InvitedHero({ days }: { days: number }) {
  return (
    <div className="text-center space-y-4">
      <Link
        to="/"
        className="text-xs uppercase tracking-widest text-neutral-500"
      >
        Printlay
      </Link>
      <div className="inline-flex items-center gap-2 rounded-full border border-violet-500/30 bg-violet-500/10 px-3 py-1 text-[10px] uppercase tracking-widest text-violet-200 font-semibold">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path
            d="M5 1l1.2 2.6L9 4l-2 2 .5 2.8L5 7.5 2.5 8.8 3 6 1 4l2.8-.4L5 1z"
            fill="currentColor"
          />
        </svg>
        You've been invited
      </div>
      <h1 className="text-3xl font-bold tracking-tight">
        Welcome to{" "}
        <span className="bg-gradient-to-r from-violet-300 to-fuchsia-300 bg-clip-text text-transparent">
          Printlay
        </span>
        .
      </h1>
      <div className="rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/[0.08] to-fuchsia-500/[0.04] p-5">
        <div className="text-[10px] uppercase tracking-widest text-violet-300 font-semibold">
          Your exclusive trial
        </div>
        <div className="mt-1 text-4xl font-bold tabular-nums text-neutral-100 tracking-tight">
          {days} days
        </div>
        <p className="mt-1 text-xs text-neutral-400">
          Full Pro access · No card required
        </p>
      </div>
      <p className="text-sm text-neutral-400 leading-relaxed">
        Set a password below to claim your trial. We'll quietly let you
        know when it's winding down — no automatic charges.
      </p>
    </div>
  );
}
