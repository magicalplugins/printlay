import { useEffect, useState } from "react";
import { ApiError } from "../api/client";
import {
  BillingStatus,
  activateLicense,
  deactivateLicense,
  getBillingStatus,
  refreshLicense,
} from "../api/billing";

const PLAN_LABELS: Record<BillingStatus["plan"], string> = {
  internal_beta: "Internal beta",
  starter: "Starter",
  professional: "Professional",
  expert: "Expert",
};

const PLAN_BLURBS: Record<BillingStatus["plan"], string> = {
  internal_beta:
    "Unlimited access while we finalise pricing. No license key needed.",
  starter: "Entry tier — limited templates and exports.",
  professional: "Unlimited templates and exports for working print shops.",
  expert: "Everything in Professional plus team and API features.",
};

export default function Settings() {
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const load = async () => {
    try {
      setStatus(await getBillingStatus());
    } catch (e) {
      setErr(formatErr(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onActivate = async () => {
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      const next = await activateLicense(keyInput.trim());
      setStatus(next);
      setKeyInput("");
      setInfo("License activated.");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const onDeactivate = async () => {
    if (!confirm("Remove this license from your account?")) return;
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      const next = await deactivateLicense();
      setStatus(next);
      setInfo("License removed.");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  const onRefresh = async () => {
    setErr(null);
    setInfo(null);
    setBusy(true);
    try {
      const next = await refreshLicense();
      setStatus(next);
      setInfo("Refreshed from license server.");
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <div className="max-w-3xl mx-auto px-6 py-12">
        <div className="h-8 w-32 rounded bg-neutral-900 animate-pulse mb-4" />
        <div className="h-4 w-72 rounded bg-neutral-900 animate-pulse" />
      </div>
    );
  }

  const planLabel = PLAN_LABELS[status.plan] ?? status.plan;
  const blurb = PLAN_BLURBS[status.plan] ?? "";

  return (
    <div className="max-w-3xl mx-auto px-6 py-12 space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
        <p className="text-neutral-400 mt-1">
          Manage your Printlay license and view your current plan.
        </p>
      </div>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
        <div className="flex items-baseline justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs uppercase tracking-wider text-neutral-500">
              Current plan
            </div>
            <div className="text-2xl font-semibold mt-1">{planLabel}</div>
          </div>
          {status.in_grace_period && (
            <span className="rounded-full bg-amber-500/10 border border-amber-500/40 px-3 py-1 text-xs text-amber-300">
              Grace period — license server unreachable
            </span>
          )}
        </div>
        <p className="text-sm text-neutral-400">{blurb}</p>

        <div className="grid sm:grid-cols-3 gap-3 pt-2">
          {Object.entries(status.limits).map(([k, v]) => (
            <div
              key={k}
              className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
            >
              <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                {humanLimit(k)}
              </div>
              <div className="text-sm font-semibold mt-0.5">
                {v === null ? "Unlimited" : v}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 space-y-4">
        <h2 className="text-lg font-semibold">License key</h2>

        {!status.server_configured && (
          <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-4 py-3 text-sm text-neutral-400">
            License server isn't configured on this deployment yet. You'll
            stay on <strong className="text-neutral-200">Internal beta</strong>{" "}
            (unlimited access) until billing goes live.
          </div>
        )}

        {status.license_key_masked ? (
          <div className="space-y-3">
            <div className="grid sm:grid-cols-2 gap-3">
              <Field label="Key" value={status.license_key_masked} mono />
              <Field
                label="Status"
                value={status.license_status ?? "unknown"}
              />
              <Field
                label="Expires"
                value={
                  status.license_expires_at
                    ? new Date(status.license_expires_at).toLocaleDateString()
                    : "—"
                }
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                onClick={onRefresh}
                disabled={busy}
                className="rounded-lg border border-neutral-700 px-4 py-2 text-sm hover:border-neutral-500 disabled:opacity-50"
              >
                Refresh
              </button>
              <button
                onClick={onDeactivate}
                disabled={busy}
                className="rounded-lg border border-rose-500/40 text-rose-300 px-4 py-2 text-sm hover:border-rose-400 disabled:opacity-50"
              >
                Remove license
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-400">
              Paste the license key emailed to you after purchase. Keys begin
              with <code className="text-neutral-200">PL-</code>.
            </p>
            <div className="flex gap-2">
              <input
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder="PL-PRO-XXXX-XXXX-XXXX-XXXX"
                spellCheck={false}
                autoCapitalize="characters"
                className="flex-1 rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono focus:border-neutral-500 focus:outline-none"
              />
              <button
                onClick={onActivate}
                disabled={busy || !keyInput.trim() || !status.server_configured}
                className="rounded-lg bg-white text-neutral-950 px-4 py-2 text-sm font-semibold hover:bg-neutral-200 disabled:opacity-50"
              >
                Activate
              </button>
            </div>
          </div>
        )}

        {err && <div className="text-sm text-rose-300">{err}</div>}
        {info && <div className="text-sm text-emerald-300">{info}</div>}
      </section>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </div>
      <div
        className={`text-sm mt-0.5 ${mono ? "font-mono" : ""} text-neutral-200`}
      >
        {value}
      </div>
    </div>
  );
}

function humanLimit(key: string) {
  return key.replace(/_/g, " ");
}

function formatErr(e: unknown): string {
  if (e instanceof ApiError) {
    const body = e.body as { detail?: string } | string | null;
    if (body && typeof body === "object" && "detail" in body && body.detail) {
      return body.detail;
    }
    return `Error ${e.status}`;
  }
  return String(e);
}
