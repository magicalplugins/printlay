import { Link } from "react-router-dom";
import { useMe } from "../../auth/MeProvider";
import { useMemo, ReactNode } from "react";

/**
 * Wraps any action button or panel that requires an active plan.
 *
 * When the user's trial has expired and they have no active subscription,
 * the children are replaced by a greyed-out version with a "Reactivate to
 * continue" overlay. The original child layout is preserved so the page
 * doesn't jump.
 *
 * Usage:
 *   <LockedOverlay feature="pdf_export">
 *     <button onClick={onGenerate}>Generate PDF</button>
 *   </LockedOverlay>
 *
 * If the user is on an active trial or active subscription the children
 * render normally with zero overhead.
 */

type Props = {
  children: ReactNode;
  /** Short description of what this action does — shown in the overlay copy. */
  action?: string;
  /** Optional class for the outer wrapper div. */
  className?: string;
};

export function useIsLocked(): boolean {
  const { me } = useMe();

  return useMemo(() => {
    if (!me) return false;
    // Admins always have full enterprise access — no plan required.
    // Mirrors the priority-0 rule in backend/services/entitlements.py.
    if (me.is_admin) return false;
    if (me.stripe_subscription_status === "active") return false;
    if (me.tier === "enterprise") return false;
    if (me.trial_ends_at) {
      const end = new Date(me.trial_ends_at).getTime();
      if (end > Date.now()) return false;
    }
    return true;
  }, [me]);
}

export default function LockedOverlay({
  children,
  action = "this feature",
  className,
}: Props) {
  const locked = useIsLocked();

  if (!locked) {
    return <>{children}</>;
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      {/* Render children dimmed so the layout doesn't collapse */}
      <div className="pointer-events-none select-none opacity-30 blur-[1px]" aria-hidden="true">
        {children}
      </div>

      {/* Overlay */}
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 rounded-xl bg-neutral-950/80 backdrop-blur-sm px-4 text-center">
        <div className="text-sm font-medium text-neutral-200">
          Subscribe to use {action}
        </div>
        <p className="text-xs text-neutral-500 max-w-[220px]">
          Your trial has ended — your templates and artwork are still here.
        </p>
        <Link
          to="/pricing"
          className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-4 py-2 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20 transition"
        >
          View plans →
        </Link>
      </div>
    </div>
  );
}

// Lighter variant: just disables a button and shows a tooltip-style label.
// Use this for individual icon buttons rather than full sections.
export function LockedButton({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const locked = useIsLocked();

  if (!locked) return <>{children}</>;

  return (
    <Link
      to="/pricing"
      className={`inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/10 px-3 py-2 text-xs font-medium text-violet-300 hover:bg-violet-500/20 transition ${className ?? ""}`}
      title="Your trial has ended — subscribe to continue"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <rect x="3" y="7" width="10" height="8" rx="1.5" />
        <path d="M5 7V5a3 3 0 1 1 6 0v2" />
      </svg>
      Subscribe to unlock
    </Link>
  );
}
