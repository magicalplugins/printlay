import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { getBillingStatus } from "../api/billing";
import { useMe } from "../auth/MeProvider";

/**
 * Landing page after a successful Stripe Checkout session. Stripe redirects
 * here with `?session_id={CHECKOUT_SESSION_ID}` but we don't actually use
 * that — the webhook is the source of truth. We just poll our own status
 * endpoint until we see `stripe_subscription_status === "active"`, then
 * forward the user back into the app.
 *
 * Why poll: webhooks can take a few seconds to deliver. Showing the user
 * "Activating…" with a real progress signal is much better UX than dumping
 * them back into a Settings page that still says "Trial expired".
 */
export default function BillingSuccess() {
  const { refresh } = useMe();
  const navigate = useNavigate();
  const [status, setStatus] = useState<"polling" | "active" | "timeout">(
    "polling"
  );

  useEffect(() => {
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 15; // ~30s @ 2s

    const poll = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const s = await getBillingStatus();
        if (s.stripe_subscription_status === "active") {
          await refresh(); // re-pull /me so banners disappear
          if (!cancelled) setStatus("active");
          // Brief celebration before redirecting.
          setTimeout(() => {
            if (!cancelled) navigate("/app", { replace: true });
          }, 1500);
          return;
        }
      } catch {
        // Network blips during webhook lag are expected — keep polling.
      }
      if (attempts >= maxAttempts) {
        if (!cancelled) setStatus("timeout");
        return;
      }
      setTimeout(poll, 2000);
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [navigate, refresh]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center px-4">
      <div className="max-w-md w-full text-center space-y-6">
        {status === "polling" && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full border-2 border-violet-500/40 border-t-violet-400 animate-spin" />
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Activating your subscription…
              </h1>
              <p className="text-sm text-neutral-400">
                Stripe is confirming your payment. This usually takes a few
                seconds.
              </p>
            </div>
          </>
        )}

        {status === "active" && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-emerald-500/20 border border-emerald-500/40 flex items-center justify-center text-2xl text-emerald-300">
              ✓
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                You're in. Welcome to PrintLay.
              </h1>
              <p className="text-sm text-neutral-400">
                Redirecting you back to the app…
              </p>
            </div>
          </>
        )}

        {status === "timeout" && (
          <>
            <div className="mx-auto w-14 h-14 rounded-full bg-amber-500/20 border border-amber-500/40 flex items-center justify-center text-2xl text-amber-300">
              !
            </div>
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Almost there
              </h1>
              <p className="text-sm text-neutral-400">
                Your payment went through, but our system is taking a little
                longer than usual to confirm. Refresh in a moment, or jump
                back into the app — your subscription will activate
                automatically.
              </p>
            </div>
            <div className="flex justify-center gap-3 pt-2">
              <Link
                to="/app"
                className="rounded-lg bg-white text-neutral-950 px-5 py-2.5 text-sm font-semibold hover:bg-neutral-200"
              >
                Continue to app →
              </Link>
              <a
                href="mailto:hello@printlay.io?subject=Stripe%20activation"
                className="rounded-lg border border-neutral-700 px-5 py-2.5 text-sm hover:border-neutral-500"
              >
                Get help
              </a>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
