import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useMe } from "../../auth/MeProvider";

interface PendingGrant {
  id: string;
  admin_email: string;
  requested_at: string;
  expires_at: string;
}

interface ActiveGrant {
  id: string;
  admin_email: string;
  accepted_at: string;
  expires_at: string;
}

const POLL_INTERVAL_MS = 15_000;
const COOLDOWN_MS = 60_000;

export default function SupportAccessModal() {
  const { me } = useMe();
  const [pending, setPending] = useState<PendingGrant | null>(null);
  const [active, setActive] = useState<ActiveGrant | null>(null);
  const [responding, setResponding] = useState(false);
  const cooldownUntil = useRef(0);

  const poll = useCallback(async () => {
    if (!me || me.is_admin) return;
    if (Date.now() < cooldownUntil.current) return;
    try {
      const [p, a] = await Promise.all([
        api<PendingGrant | null>("/api/support-access/pending"),
        api<ActiveGrant | null>("/api/support-access/active"),
      ]);
      setPending(p ?? null);
      setActive(a ?? null);
    } catch {
      // Silently ignore polling failures
    }
  }, [me]);

  useEffect(() => {
    if (!me || me.is_admin) return;
    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [me, poll]);

  const respond = useCallback(
    async (accept: boolean) => {
      if (!pending) return;
      setResponding(true);
      try {
        await api(`/api/support-access/${pending.id}/respond`, {
          method: "POST",
          body: JSON.stringify({ accept }),
        });
        setPending(null);
        cooldownUntil.current = Date.now() + COOLDOWN_MS;
        if (accept) {
          const a = await api<ActiveGrant | null>(
            "/api/support-access/active"
          );
          setActive(a ?? null);
        }
      } catch {
        // Will retry on next poll
      } finally {
        setResponding(false);
      }
    },
    [pending]
  );

  const revoke = useCallback(async () => {
    if (!active) return;
    try {
      await api(`/api/support-access/${active.id}/revoke`, {
        method: "POST",
      });
      setActive(null);
    } catch {
      // Will retry on next poll
    }
  }, [active]);

  return (
    <>
      {pending && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-8 shadow-2xl">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-10 h-10 rounded-full bg-violet-500/20 flex items-center justify-center text-violet-300 shrink-0">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path
                    d="M10 2a4 4 0 014 4v1a1 1 0 011 1v7a2 2 0 01-2 2H7a2 2 0 01-2-2V8a1 1 0 011-1V6a4 4 0 014-4zm0 2a2 2 0 00-2 2v1h4V6a2 2 0 00-2-2z"
                    fill="currentColor"
                  />
                </svg>
              </div>
              <h2 className="text-lg font-bold text-white">
                Support Access Request
              </h2>
            </div>

            <p className="text-neutral-300 text-sm leading-relaxed mb-2">
              <strong className="text-white">{pending.admin_email}</strong> is
              requesting temporary access to your account to help resolve your
              issue.
            </p>

            <ul className="text-neutral-400 text-xs space-y-1 mb-6 list-disc pl-4">
              <li>Access will expire in 1 hour</li>
              <li>You can revoke access at any time</li>
              <li>All actions are logged for your security</li>
            </ul>

            <div className="flex gap-3">
              <button
                onClick={() => respond(true)}
                disabled={responding}
                className="flex-1 h-11 rounded-xl bg-emerald-600 text-white font-semibold text-sm hover:bg-emerald-500 disabled:opacity-50 transition"
              >
                {responding ? "..." : "Allow Access"}
              </button>
              <button
                onClick={() => respond(false)}
                disabled={responding}
                className="flex-1 h-11 rounded-xl border border-neutral-700 text-neutral-300 font-semibold text-sm hover:border-neutral-500 hover:text-white disabled:opacity-50 transition"
              >
                Deny
              </button>
            </div>
          </div>
        </div>
      )}

      {active && !pending && (
        <div className="w-full bg-violet-600/90 text-white px-4 py-2 flex items-center justify-center gap-3 text-sm z-40 relative flex-wrap">
          <svg
            width="14"
            height="14"
            viewBox="0 0 20 20"
            fill="none"
            className="shrink-0"
          >
            <path
              d="M10 2a8 8 0 100 16 8 8 0 000-16zm0 2a2.5 2.5 0 110 5 2.5 2.5 0 010-5zm0 10.5c-2.03 0-3.8-1.04-4.84-2.62.02-1.6 3.23-2.48 4.84-2.48 1.6 0 4.82.88 4.84 2.48A5.98 5.98 0 0110 14.5z"
              fill="currentColor"
            />
          </svg>
          <span>
            A support agent (<strong>{active.admin_email}</strong>) is viewing
            your account
          </span>
          <button
            onClick={revoke}
            className="rounded-md bg-white/20 px-3 py-1 text-xs font-semibold hover:bg-white/30 transition"
          >
            Revoke access
          </button>
        </div>
      )}
    </>
  );
}
