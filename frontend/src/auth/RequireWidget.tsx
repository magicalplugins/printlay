import { ReactNode, useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { getBillingStatus } from "../api/billing";
import { useMe } from "./MeProvider";

/** Renders children only for users entitled to the embeddable widget
 *  (`widget_access`, i.e. Studio + admins). The backend is the real gate;
 *  this avoids flashing the page chrome before the API 403s, and bounces
 *  un-entitled users to /pricing. */
export function RequireWidget({ children }: { children: ReactNode }) {
  const { me } = useMe();
  const [state, setState] = useState<"checking" | "allowed" | "denied">("checking");

  useEffect(() => {
    let cancelled = false;
    if (me?.is_admin) {
      setState("allowed");
      return;
    }
    getBillingStatus()
      .then((s) => {
        if (cancelled) return;
        setState(s.features.includes("widget_access") ? "allowed" : "denied");
      })
      .catch(() => !cancelled && setState("denied"));
    return () => {
      cancelled = true;
    };
  }, [me?.is_admin]);

  if (state === "checking") {
    return (
      <div className="min-h-full flex items-center justify-center">
        <div className="text-neutral-500 text-sm">Loading…</div>
      </div>
    );
  }
  if (state === "denied") {
    return <Navigate to="/pricing" replace />;
  }
  return <>{children}</>;
}
