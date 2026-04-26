import { Link } from "react-router-dom";
import { useMe } from "../../auth/MeProvider";
import { useMemo } from "react";

/**
 * Persistent top-of-page trial countdown banner. Appears only when:
 *   - User is on a Pro trial (trial_ends_at is set + in the future)
 *   - AND there are 7 or fewer days remaining
 *
 * Invisible at days 8-14 so it doesn't distract during the honeymoon
 * period — shown from day 7 onward to build urgency without being annoying
 * from day one.
 *
 * Rendered inside Layout, just below the sticky header, so it persists
 * across all in-app pages without each page needing to know about billing.
 */
export default function TrialBanner() {
  const { me } = useMe();

  const daysLeft = useMemo(() => {
    if (!me?.trial_ends_at) return null;
    if (me.is_admin) return null;
    if (me.stripe_subscription_status === "active") return null;
    const end = new Date(me.trial_ends_at).getTime();
    const now = Date.now();
    if (end <= now) return null;
    return Math.max(0, Math.ceil((end - now) / (1000 * 60 * 60 * 24)));
  }, [me?.trial_ends_at, me?.stripe_subscription_status, me?.is_admin]);

  if (daysLeft === null || daysLeft > 7) return null;

  const urgent = daysLeft <= 2;
  const warning = daysLeft <= 5;

  const message =
    daysLeft === 0
      ? "Your free trial expires today."
      : daysLeft === 1
      ? "1 day left on your free trial."
      : `${daysLeft} days left on your free trial.`;

  return (
    <div
      className={`w-full px-3 py-2.5 text-center text-sm flex items-center justify-center gap-3 flex-wrap ${
        urgent
          ? "bg-rose-500/10 border-b border-rose-500/30 text-rose-200"
          : warning
          ? "bg-amber-500/10 border-b border-amber-500/30 text-amber-200"
          : "bg-violet-500/10 border-b border-violet-500/30 text-violet-200"
      }`}
    >
      <span>
        {message}{" "}
        <span className="text-neutral-400">
          Your templates and artwork are preserved when you subscribe.
        </span>
      </span>
      <Link
        to="/pricing"
        className={`rounded-md px-3 py-1 text-xs font-semibold border transition shrink-0 ${
          urgent
            ? "border-rose-400/60 text-rose-200 hover:bg-rose-500/20"
            : warning
            ? "border-amber-400/60 text-amber-200 hover:bg-amber-500/20"
            : "border-violet-400/60 text-violet-200 hover:bg-violet-500/20"
        }`}
      >
        Choose a plan →
      </Link>
    </div>
  );
}
