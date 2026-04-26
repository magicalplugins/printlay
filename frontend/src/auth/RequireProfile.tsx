import { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useMe } from "./MeProvider";

/** Redirects to /profile-setup if the user hasn't supplied phone/company.
 *  Wrapped INSIDE <RequireAuth> so we only evaluate it once we know the
 *  user is signed in. While /me is loading we render nothing rather than
 *  flashing a redirect. */
export function RequireProfile({ children }: { children: ReactNode }) {
  const { me, loading, error } = useMe();
  const location = useLocation();

  if (loading || (!me && !error)) {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-full flex items-center justify-center px-6">
        <div className="text-rose-300 text-sm max-w-md text-center">
          Couldn't load your profile: {error}
        </div>
      </div>
    );
  }

  if (me?.needs_profile) {
    return (
      <Navigate
        to="/profile-setup"
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  return <>{children}</>;
}
