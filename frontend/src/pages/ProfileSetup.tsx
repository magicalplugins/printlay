import { FormEvent, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { updateProfile } from "../api/me";
import { useMe } from "../auth/MeProvider";

/** One-time post-signup profile gate. Phone is required (used for SMS
 *  outreach later); company is optional. Once submitted, /me returns
 *  needs_profile=false and the layout stops redirecting here. */
export default function ProfileSetup() {
  const { me, setMe } = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [phone, setPhone] = useState(me?.phone ?? "");
  const [company, setCompany] = useState(me?.company_name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Where to send the user after they finish - either back to where they
  // were trying to go, or the dashboard.
  const next =
    (location.state as { from?: string } | null)?.from ?? "/app";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const updated = await updateProfile({
        phone: phone.trim(),
        company_name: company.trim() || null,
      });
      setMe(updated);
      navigate(next, { replace: true });
    } catch (e2) {
      if (e2 instanceof ApiError) {
        const body = e2.body as { detail?: unknown } | string;
        const detail =
          typeof body === "string"
            ? body
            : Array.isArray(body?.detail)
              ? body.detail
                  .map((d: { msg?: string }) => d.msg ?? "Invalid")
                  .join(" · ")
              : (body?.detail as string) ?? `HTTP ${e2.status}`;
        setErr(String(detail));
      } else {
        setErr(String(e2));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-start justify-center px-4 py-12">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold tracking-tight">
            Almost there
          </h1>
          <p className="text-neutral-400 mt-2 text-sm">
            One quick step before you start designing. We'll use your phone
            number for important account notices and (optional) feature
            announcements - never anything spammy.
          </p>
        </div>

        <form
          onSubmit={onSubmit}
          className="space-y-5 rounded-2xl border border-neutral-800 bg-neutral-950/60 p-6 shadow-xl"
        >
          <div>
            <label className="text-xs uppercase tracking-widest text-neutral-500">
              Phone <span className="text-rose-400">*</span>
            </label>
            <input
              type="tel"
              required
              autoFocus
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+44 7123 456789"
              className="mt-1 w-full h-11 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-sm outline-none focus:border-violet-500"
            />
            <p className="text-[11px] text-neutral-500 mt-1">
              Include the country code (+44, +1, ...).
            </p>
          </div>

          <div>
            <label className="text-xs uppercase tracking-widest text-neutral-500">
              Company name <span className="text-neutral-600">(optional)</span>
            </label>
            <input
              type="text"
              autoComplete="organization"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="Acme Print Co."
              className="mt-1 w-full h-11 rounded-lg border border-neutral-800 bg-neutral-950 px-3 text-sm outline-none focus:border-violet-500"
            />
            <p className="text-[11px] text-neutral-500 mt-1">
              Leave blank if you're a sole trader or hobbyist.
            </p>
          </div>

          {err && (
            <div className="rounded-md border border-rose-900/60 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
              {err}
            </div>
          )}

          <button
            type="submit"
            disabled={busy || !phone.trim()}
            className="w-full h-11 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm font-semibold shadow-lg shadow-violet-500/20 hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? "Saving…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}
