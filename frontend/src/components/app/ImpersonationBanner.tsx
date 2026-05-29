import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../../api/client";
import {
  type Impersonation,
  endImpersonation,
  getImpersonation,
  subscribe,
} from "../../auth/impersonation";

export default function ImpersonationBanner() {
  const imp = useSyncExternalStore(subscribe, getImpersonation);
  if (!imp) return null;
  return <Banner imp={imp} />;
}

function Banner({ imp }: { imp: Impersonation }) {
  const [remaining, setRemaining] = useState("");

  useEffect(() => {
    function tick() {
      const ms = new Date(imp.expiresAt).getTime() - Date.now();
      if (ms <= 0) {
        setRemaining("expired");
        return;
      }
      const mins = Math.ceil(ms / 60_000);
      setRemaining(mins <= 1 ? "<1 min" : `${mins} min`);
    }
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [imp.expiresAt]);

  const handleEnd = useCallback(async () => {
    try {
      await api(`/api/admin/support-access/${imp.grantId}/end`, {
        method: "POST",
      });
    } catch {
      // Best-effort; the grant will expire on its own
    }
    endImpersonation();
    window.location.reload();
  }, [imp.grantId]);

  return (
    <div className="w-full bg-amber-500 text-neutral-950 px-4 py-2 flex items-center justify-center gap-4 text-sm font-medium z-50 relative flex-wrap">
      <span>
        Viewing as <strong>{imp.userEmail}</strong> &mdash; {remaining}{" "}
        remaining
      </span>
      <button
        onClick={handleEnd}
        className="rounded-md bg-neutral-950 text-white px-3 py-1 text-xs font-semibold hover:bg-neutral-800 transition"
      >
        End session
      </button>
    </div>
  );
}
