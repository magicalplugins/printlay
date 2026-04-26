import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  BillingStatus,
  getBillingStatus,
  openCustomerPortal,
  Plan,
} from "../api/billing";
import {
  ColorProfile,
  ColorSwap,
  createColorProfile,
  deleteColorProfile,
  duplicateColorProfile,
  listColorProfiles,
  updateColorProfile,
} from "../api/colorProfiles";
import { updateProfile } from "../api/me";
import { useAuth } from "../auth/AuthProvider";
import { useMe } from "../auth/MeProvider";
import ColorProfileEditor from "../components/app/ColorProfileEditor";
import { formatErr } from "../utils/apiError";

const PLAN_LABELS: Record<Plan, string> = {
  locked: "Locked",
  starter: "Starter",
  pro: "Pro",
  studio: "Studio",
  enterprise: "Enterprise",
};

const PLAN_BLURBS: Record<Plan, string> = {
  locked: "Your trial has ended. Pick a plan to get back to work — your templates and artwork are all still here.",
  starter: "Great for solo print operators. 5 templates, 200 exports / month, 5 GB storage.",
  pro: "Unlimited templates and PDF exports for working print shops. 50 GB storage, catalogue sharing.",
  studio: "Everything in Pro plus API access, white-label PDFs, larger uploads, and 250 GB storage.",
  enterprise: "Custom multi-seat access for larger operations. Get in touch for pricing and onboarding.",
};

type Tab = "account" | "colors" | "preferences";

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const raw = params.get("tab");
  const tab: Tab =
    raw === "preferences" ? "preferences" : raw === "colors" ? "colors" : "account";

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    if (t === "account") next.delete("tab");
    else next.set("tab", t);
    setParams(next, { replace: true });
  };

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-6 py-6 sm:py-12 space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          Settings
        </h1>
        <p className="text-neutral-400 text-sm sm:text-base">
          Manage your plan, profile, and global preferences.
        </p>
      </header>

      {/* Sub-tabs deliberately styled as small text-link toggles, not big
          pills - they should feel secondary so the page header still
          reads as the primary anchor. Underline + colour shift signals
          the active one. */}
      <nav
        className="flex items-center gap-5 border-b border-neutral-900 -mt-2"
        aria-label="Settings sections"
      >
        <SubTab active={tab === "account"} onClick={() => setTab("account")}>
          Account
        </SubTab>
        <SubTab active={tab === "colors"} onClick={() => setTab("colors")}>
          Color profiles
        </SubTab>
        <SubTab
          active={tab === "preferences"}
          onClick={() => setTab("preferences")}
        >
          Preferences
        </SubTab>
      </nav>

      {tab === "account" ? (
        <AccountTab />
      ) : tab === "colors" ? (
        <ColorProfilesTab />
      ) : (
        <PreferencesTab />
      )}
    </div>
  );
}

function SubTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={
        "relative -mb-px py-2 text-sm transition-colors " +
        (active
          ? "text-white border-b-2 border-violet-500"
          : "text-neutral-500 hover:text-neutral-200 border-b-2 border-transparent")
      }
    >
      {children}
    </button>
  );
}

/* ────────────────────────────────────────────────────────────────────
   ACCOUNT TAB
   Plan + license, profile (phone/company), and account-level actions.
   ──────────────────────────────────────────────────────────────────── */

function AccountTab() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState<BillingStatus | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [openingPortal, setOpeningPortal] = useState(false);
  const [planChangedNote, setPlanChangedNote] = useState<string | null>(null);

  useEffect(() => {
    getBillingStatus().then(setStatus).catch((e) => setErr(formatErr(e)));
  }, []);

  // Returning from /pricing → /change-plan → Customer Portal? Show a
  // brief "Plan updated" confirmation and poll status for ~10s so we
  // pick up the new price as soon as the webhook lands. Stripe usually
  // fires customer.subscription.updated within 1–2 seconds; we keep
  // polling beyond that just in case the Customer Portal redirect beats
  // the webhook.
  const pollHandle = useRef<number | null>(null);
  useEffect(() => {
    if (params.get("plan_changed") !== "1") return;
    setPlanChangedNote(
      "Plan updated. Your new limits are live — refreshing in a moment."
    );
    // Strip the marker so a refresh doesn't re-trigger the banner.
    const next = new URLSearchParams(params);
    next.delete("plan_changed");
    setParams(next, { replace: true });

    const startedAt = Date.now();
    const poll = () => {
      getBillingStatus()
        .then((s) => setStatus(s))
        .catch(() => {})
        .finally(() => {
          if (Date.now() - startedAt < 10_000) {
            pollHandle.current = window.setTimeout(poll, 1500);
          } else {
            setPlanChangedNote(null);
          }
        });
    };
    pollHandle.current = window.setTimeout(poll, 800);
    return () => {
      if (pollHandle.current !== null) {
        window.clearTimeout(pollHandle.current);
        pollHandle.current = null;
      }
    };
  // We only want this to fire on the initial entry with the flag
  // present — after stripping it, params changes and the early-return
  // above keeps us idle. Intentionally no `params` in deps to avoid
  // re-triggering when other tab params change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOpenPortal = async () => {
    setErr(null);
    setOpeningPortal(true);
    try {
      const { url } = await openCustomerPortal({
        return_url: window.location.href,
      });
      window.location.href = url;
    } catch (e) {
      setErr(formatErr(e));
      setOpeningPortal(false);
    }
  };

  if (err && !status) {
    return <div className="text-sm text-rose-300">{err}</div>;
  }

  if (!status) {
    return (
      <div className="space-y-3">
        <div className="h-8 w-32 rounded bg-neutral-900 animate-pulse" />
        <div className="h-4 w-72 rounded bg-neutral-900 animate-pulse" />
      </div>
    );
  }

  const planLabel = PLAN_LABELS[status.plan] ?? status.plan;
  const blurb = PLAN_BLURBS[status.plan] ?? "";
  const isLocked = status.plan === "locked";
  const isTrialing = status.is_trialing;

  const trialDaysLeft = status.trial_ends_at
    ? Math.max(
        0,
        Math.ceil(
          (new Date(status.trial_ends_at).getTime() - Date.now()) /
            (1000 * 60 * 60 * 24)
        )
      )
    : null;

  const renewalDate = status.stripe_current_period_end
    ? new Date(status.stripe_current_period_end).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    : null;

  return (
    <div className="space-y-8">
      {planChangedNote && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200 flex items-start gap-3">
          <span aria-hidden className="mt-0.5">✓</span>
          <span>{planChangedNote}</span>
        </div>
      )}

      <ProfileSection />

      {/* Plan card */}
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 sm:p-6 space-y-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
              Current plan
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-2xl font-bold tracking-tight">{planLabel}</span>
              {status.founder_member && (
                <span className="rounded-full bg-violet-500/15 border border-violet-500/40 px-2.5 py-0.5 text-xs font-medium text-violet-300">
                  Founder
                </span>
              )}
              {isTrialing && trialDaysLeft !== null && (
                <span
                  className={`rounded-full px-2.5 py-0.5 text-xs font-medium border ${
                    trialDaysLeft <= 2
                      ? "bg-rose-500/10 border-rose-500/40 text-rose-300"
                      : trialDaysLeft <= 7
                      ? "bg-amber-500/10 border-amber-500/40 text-amber-300"
                      : "bg-emerald-500/10 border-emerald-500/40 text-emerald-300"
                  }`}
                >
                  {trialDaysLeft === 0
                    ? "Trial expires today"
                    : `${trialDaysLeft} day${trialDaysLeft === 1 ? "" : "s"} left on trial`}
                </span>
              )}
            </div>
            <p className="text-sm text-neutral-400 mt-1.5 max-w-md">{blurb}</p>
          </div>

          {/* Action buttons — shown for active paid plans */}
          {!isLocked && !isTrialing && status.stripe_subscription_status === "active" && (
            <button
              onClick={onOpenPortal}
              disabled={openingPortal}
              className="rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-500 hover:text-white transition disabled:opacity-50"
            >
              {openingPortal ? "Opening…" : "Manage billing →"}
            </button>
          )}
        </div>

        {/* Trial progress bar */}
        {isTrialing && trialDaysLeft !== null && (
          <div>
            <div className="flex items-center justify-between text-xs text-neutral-500 mb-1.5">
              <span>Trial progress</span>
              <span>{trialDaysLeft} days remaining</span>
            </div>
            <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden">
              <div
                className="h-full rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 transition-all"
                style={{ width: `${Math.max(5, ((14 - trialDaysLeft) / 14) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Renewal date */}
        {renewalDate && !isLocked && (
          <p className="text-xs text-neutral-500">
            Next renewal: {renewalDate}
          </p>
        )}

        {/* Locked CTA */}
        {isLocked && (
          <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-4 space-y-3">
            <p className="text-sm text-neutral-300">
              Your templates, artwork, and colour profiles are all still here —
              pick a plan to get back to work.
            </p>
            <div className="flex flex-wrap gap-2">
              <a
                href="/pricing"
                className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20 transition"
              >
                View plans →
              </a>
            </div>
          </div>
        )}

        {/* Trial upgrade nudge (shows from day 7) */}
        {isTrialing && trialDaysLeft !== null && trialDaysLeft <= 7 && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-3">
            <p className="text-sm text-neutral-300">
              {trialDaysLeft <= 2
                ? "Your trial ends very soon. Don't lose access — subscribe now and everything stays exactly as it is."
                : `${trialDaysLeft} days left on your trial. Subscribe now to keep your templates, artwork, and colour profiles.`}
            </p>
            <a
              href="/pricing"
              className="inline-flex rounded-lg bg-white text-neutral-950 px-4 py-2 text-sm font-semibold hover:bg-neutral-200 transition"
            >
              Choose a plan →
            </a>
          </div>
        )}

        {/* Limits grid */}
        {!isLocked && (
          <div className="grid sm:grid-cols-3 gap-3 pt-1">
            {Object.entries(status.limits)
              .filter(([k]) => k !== "asset_size_mb_max")
              .map(([k, v]) => (
                <div
                  key={k}
                  className="rounded-lg border border-neutral-800 bg-neutral-950/50 px-3 py-2"
                >
                  <div className="text-[10px] uppercase tracking-wider text-neutral-500">
                    {humanLimit(k)}
                  </div>
                  <div className="text-sm font-semibold mt-0.5">
                    {v === null ? "Unlimited" : v === 0 ? "—" : v}
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   PROFILE SECTION
   Lightweight in-place editor for phone + company. Used to be hidden
   behind the post-signup gate; surfacing it here lets users update it
   any time without us having to redirect them through ProfileSetup.
   ──────────────────────────────────────────────────────────────────── */

function ProfileSection() {
  const { session } = useAuth();
  const { me, refresh, setMe } = useMe();
  const [phone, setPhone] = useState(me?.phone ?? "");
  const [company, setCompany] = useState(me?.company_name ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState(false);

  // Re-sync local form state whenever the cached `me` changes (e.g.
  // first load, or a refresh from elsewhere). Without this the form
  // stays empty after navigating from a fresh sign-in.
  useEffect(() => {
    setPhone(me?.phone ?? "");
    setCompany(me?.company_name ?? "");
  }, [me?.phone, me?.company_name]);

  const dirty =
    phone.trim() !== (me?.phone ?? "") ||
    (company.trim() || null) !== (me?.company_name ?? null);

  const onSave = async () => {
    setBusy(true);
    setErr(null);
    try {
      const next = await updateProfile({
        phone: phone.trim(),
        company_name: company.trim() || null,
      });
      setMe(next);
      await refresh();
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 1800);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 sm:p-6 space-y-4">
      <div className="flex items-baseline justify-between flex-wrap gap-2">
        <h2 className="text-lg font-semibold">Profile</h2>
        <span className="text-xs text-neutral-500 truncate max-w-full">
          {session?.user.email}
        </span>
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Phone <span className="text-rose-400 normal-case">required</span>
          </div>
          <input
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="+44 7700 900000"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
          />
        </label>
        <label className="block">
          <div className="text-xs uppercase tracking-wider text-neutral-500 mb-1">
            Company <span className="text-neutral-600 normal-case">optional</span>
          </div>
          <input
            type="text"
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            placeholder="Magic Plugins"
            className="w-full rounded-lg border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none"
          />
        </label>
      </div>

      {err && <div className="text-sm text-rose-300">{err}</div>}

      <div className="flex items-center gap-3">
        <button
          onClick={onSave}
          disabled={busy || !dirty || phone.trim().length < 6}
          className="rounded-lg bg-white text-neutral-950 px-4 py-2 text-sm font-semibold hover:bg-neutral-200 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save profile"}
        </button>
        {savedHint && (
          <span className="text-sm text-emerald-300">Saved ✓</span>
        )}
      </div>
    </section>
  );
}

/* ────────────────────────────────────────────────────────────────────
   PREFERENCES TAB
   Placeholder today, designed to grow. As we add real global settings
   (default bleed, fit mode, theme, language...) they live here.
   ──────────────────────────────────────────────────────────────────── */

function PreferencesTab() {
  return (
    <div className="space-y-6">
      <section className="rounded-2xl border border-dashed border-neutral-800 bg-neutral-900/30 p-6 sm:p-8 text-center">
        <div className="text-2xl mb-2" aria-hidden>
          ⚙
        </div>
        <h2 className="text-lg font-semibold mb-1">
          Global preferences are coming soon
        </h2>
        <p className="text-sm text-neutral-400 max-w-md mx-auto leading-relaxed">
          This is where defaults that apply across every template and job will
          live — think default bleed for new templates, preferred fit mode,
          measurement units, and theme. Tell us what you'd like first.
        </p>
      </section>

      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 sm:p-6">
        <div className="text-xs uppercase tracking-wider text-neutral-500 mb-2">
          On the roadmap
        </div>
        <ul className="text-sm text-neutral-300 space-y-1.5">
          <li>· Default bleed &amp; safe margin for new templates</li>
          <li>· Default artwork fit mode (Contain / Fill / Stretch)</li>
          <li>· Measurement units (mm / inches)</li>
          <li>· Light / dark theme</li>
          <li>· Notification preferences (email / SMS)</li>
        </ul>
      </section>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
   COLOR PROFILES TAB
   Per-user library of named RGB swap rules (e.g. "ROLAND PRINTER").
   Lives here so changes propagate to every job that links the profile.
   ──────────────────────────────────────────────────────────────────── */

function ColorProfilesTab() {
  const [items, setItems] = useState<ColorProfile[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = async () => {
    try {
      const list = await listColorProfiles();
      setItems(list);
    } catch (e) {
      setErr(formatErr(e));
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onCreate = async () => {
    setErr(null);
    setBusyId("__new__");
    try {
      const p = await createColorProfile({ name: "New profile", swaps: [] });
      setItems((cur) => (cur ? [p, ...cur] : [p]));
      setEditingId(p.id);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDuplicate = async (id: string) => {
    setBusyId(id);
    try {
      const p = await duplicateColorProfile(id);
      setItems((cur) => (cur ? [p, ...cur] : [p]));
      setEditingId(p.id);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (id: string, jobCount: number) => {
    const msg =
      jobCount > 0
        ? `Delete this profile? ${jobCount} job(s) will lose their colour swaps.`
        : "Delete this profile?";
    if (!confirm(msg)) return;
    setBusyId(id);
    try {
      await deleteColorProfile(id);
      setItems((cur) => (cur ? cur.filter((p) => p.id !== id) : cur));
      if (editingId === id) setEditingId(null);
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusyId(null);
    }
  };

  const onSave = async (
    id: string,
    patch: { name?: string; swaps?: ColorSwap[] }
  ) => {
    setBusyId(id);
    try {
      const next = await updateColorProfile(id, patch);
      setItems((cur) =>
        cur ? cur.map((p) => (p.id === id ? next : p)) : cur
      );
    } catch (e) {
      setErr(formatErr(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 sm:p-6 space-y-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-lg font-semibold">Color profiles</h2>
            <p className="text-sm text-neutral-400 mt-1 max-w-xl">
              Save per-printer RGB swap rules and attach them to any job
              before generating a PDF. Output is always written as DeviceRGB
              so Adobe shows the exact same triplet you typed.
            </p>
          </div>
          <button
            onClick={onCreate}
            disabled={busyId === "__new__"}
            className="rounded-lg bg-white text-neutral-950 px-4 py-2 text-sm font-semibold hover:bg-neutral-200 disabled:opacity-50"
          >
            + New profile
          </button>
        </div>
        {err && <div className="text-sm text-rose-300">{err}</div>}
      </section>

      {items === null ? (
        <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 animate-pulse">
          <div className="h-4 w-40 bg-neutral-800 rounded mb-3" />
          <div className="h-3 w-72 bg-neutral-800 rounded" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 p-10 text-center text-sm text-neutral-500">
          No profiles yet. Click <strong>+ New profile</strong> to create one,
          or set up swaps directly on a job and save it from there.
        </div>
      ) : (
        <ul className="space-y-3">
          {items.map((p) => (
            <ColorProfileRow
              key={p.id}
              profile={p}
              editing={editingId === p.id}
              onEdit={() => setEditingId(p.id)}
              onClose={() => setEditingId(null)}
              onSave={(patch) => onSave(p.id, patch)}
              onDelete={() => onDelete(p.id, p.job_count)}
              onDuplicate={() => onDuplicate(p.id)}
              busy={busyId === p.id}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ColorProfileRow({
  profile,
  editing,
  onEdit,
  onClose,
  onSave,
  onDelete,
  onDuplicate,
  busy,
}: {
  profile: ColorProfile;
  editing: boolean;
  onEdit: () => void;
  onClose: () => void;
  onSave: (patch: { name?: string; swaps?: ColorSwap[] }) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  busy: boolean;
}) {
  const [name, setName] = useState(profile.name);
  const [swaps, setSwaps] = useState<ColorSwap[]>(profile.swaps);
  const [savedHint, setSavedHint] = useState(false);

  // Sync local state when the underlying profile changes (e.g. after save).
  useEffect(() => {
    setName(profile.name);
    setSwaps(profile.swaps);
  }, [profile.id, profile.updated_at]);

  const dirty =
    name.trim() !== profile.name ||
    JSON.stringify(swaps) !== JSON.stringify(profile.swaps);

  const handleSave = async () => {
    onSave({ name: name.trim() || profile.name, swaps });
    setSavedHint(true);
    setTimeout(() => setSavedHint(false), 1500);
  };

  return (
    <li className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4 sm:p-5 space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        {editing ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="flex-1 min-w-[12rem] rounded-lg border border-violet-500/50 bg-neutral-950 px-3 py-1.5 text-base font-semibold focus:outline-none focus:ring-2 focus:ring-violet-500/40"
            maxLength={200}
          />
        ) : (
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{profile.name}</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {profile.swaps.length} swap{profile.swaps.length === 1 ? "" : "s"}
              {profile.job_count > 0 &&
                ` · used by ${profile.job_count} job${
                  profile.job_count === 1 ? "" : "s"
                }`}
            </div>
          </div>
        )}

        <div className="flex items-center gap-1">
          <SwatchStrip swaps={profile.swaps} />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          {editing ? (
            <>
              <button
                onClick={handleSave}
                disabled={busy || !dirty}
                className="rounded-md bg-emerald-500 text-emerald-950 px-3 py-1.5 text-sm font-semibold hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                onClick={onClose}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm hover:border-neutral-500"
              >
                Done
              </button>
            </>
          ) : (
            <>
              <button
                onClick={onEdit}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm hover:border-violet-500"
              >
                Edit
              </button>
              <button
                onClick={onDuplicate}
                disabled={busy}
                className="rounded-md border border-neutral-700 px-3 py-1.5 text-sm hover:border-neutral-500 disabled:opacity-50"
                title="Duplicate (e.g. to tweak for a second machine)"
              >
                Duplicate
              </button>
              <button
                onClick={onDelete}
                disabled={busy}
                className="rounded-md border border-rose-500/40 text-rose-300 px-3 py-1.5 text-sm hover:border-rose-400 disabled:opacity-50"
              >
                Delete
              </button>
            </>
          )}
          {savedHint && (
            <span className="text-xs text-emerald-300">Saved ✓</span>
          )}
        </div>
      </div>

      {editing && (
        <div className="pt-2">
          <ColorProfileEditor
            swaps={swaps}
            onChange={setSwaps}
            compact
          />
        </div>
      )}
    </li>
  );
}

function SwatchStrip({ swaps }: { swaps: ColorSwap[] }) {
  if (swaps.length === 0) return null;
  return (
    <div className="hidden sm:flex items-center gap-0.5">
      {swaps.slice(0, 6).map((s, i) => (
        <span
          key={i}
          className="h-5 w-5 rounded-sm border border-neutral-700"
          style={{ backgroundColor: `rgb(${s.target.join(",")})` }}
          title={`#${s.target
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("")
            .toUpperCase()}`}
        />
      ))}
      {swaps.length > 6 && (
        <span className="text-xs text-neutral-500 ml-1">+{swaps.length - 6}</span>
      )}
    </div>
  );
}


function humanLimit(key: string) {
  return key.replace(/_/g, " ");
}

