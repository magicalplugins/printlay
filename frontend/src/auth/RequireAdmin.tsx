import { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useMe } from "./MeProvider";

/** Renders children only if /me reports the user as admin. Non-admins are
 *  silently bounced to the dashboard - they shouldn't even know the route
 *  exists. The backend gate (require_admin) is the real enforcement; this
 *  is just a UX nicety to avoid showing the page chrome before the API
 *  inevitably 403s. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me, loading, error } = useMe();

  if (loading || (!me && !error)) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (!me?.is_admin) {
    return <Navigate to="/app" replace />;
  }

  return <>{children}</>;
}
