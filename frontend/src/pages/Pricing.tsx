import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  changePlan,
  FounderOffer,
  getPlans,
  PlanItem,
  PlansResponse,
  startCheckout,
} from "../api/billing";
import { useAuth } from "../auth/AuthProvider";
import { useMe } from "../auth/MeProvider";
import { formatErr } from "../utils/apiError";

type Cadence = "monthly" | "annual";

/**
 * Public pricing page. Reachable from:
 *   - The pre-auth landing pages (footer + nav)
 *   - The in-app TrialBanner / LockedOverlay / Settings "View plans" CTAs
 *
 * Behaviour differs by auth state:
 *   - Logged out → "Subscribe" buttons go to /register?next=/pricing
 *   - Logged in  → "Subscribe" hits /api/billing/checkout and redirects
 *                  to Stripe-hosted Checkout
 *
 * Designed to feel inevitable, not pressured: a single annual/monthly
 * toggle, three cards, an enterprise tier with no price visible (the
 * "if you have to ask" signal that creates the right kind of scarcity).
 */
export default function Pricing() {
  const { session } = useAuth();
  const { me } = useMe();
  const navigate = useNavigate();

  const [data, setData] = useState<PlansResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cadence, setCadence] = useState<Cadence>("monthly");
  const [busyPlanId, setBusyPlanId] = useState<string | null>(null);

  useEffect(() => {
    getPlans().then(setData).catch((e) => setErr(formatErr(e)));
  }, []);

  const isAuthed = !!session;
  const isLockedAccount =
    !!me &&
    me.stripe_subscription_status !== "active" &&
    me.tier !== "enterprise" &&
    (!me.trial_ends_at || new Date(me.trial_ends_at).getTime() <= Date.now());

  // A user with a live Stripe subscription should switch plans by
  // *modifying* their existing one (one customer, one sub, with
  // proration) — not by spawning a brand-new checkout that would
  // double-bill them. We route those through /change-plan instead.
  const hasLiveSubscription =
    !!me &&
    !!me.stripe_subscription_status &&
    ["active", "trialing", "past_due"].includes(me.stripe_subscription_status);

  // The founder offer flag drives both the strike-through UI and the
  // coupon we attach to checkout. Server is the source of truth: if the
  // offer is active, we MUST pass the code so the price the customer
  // sees matches what Stripe charges. Display without auto-apply would
  // be a bait-and-switch.
  const founderOffer: FounderOffer | null = data?.founder_offer ?? null;
  const founderActive = !!founderOffer?.active;

  const onSelectPlan = async (plan: PlanItem) => {
    const priceId =
      cadence === "annual" ? plan.annual_price_id : plan.monthly_price_id;

    if (!priceId) {
      setErr(
        "This plan isn't available yet. We're still finalising pricing — please check back shortly or get in touch."
      );
      return;
    }

    if (!isAuthed) {
      navigate(`/register?next=${encodeURIComponent("/pricing")}`);
      return;
    }

    setBusyPlanId(plan.id);
    setErr(null);
    try {
      const origin = window.location.origin;

      if (hasLiveSubscription) {
        // Modify the live subscription via the Customer Portal. Stripe
        // shows a proration summary and a single "Confirm change"
        // button; the webhook then mirrors the new price onto the
        // user row, so by the time they're back on /settings the
        // plan label reads correctly.
        const { url } = await changePlan({
          price_id: priceId,
          return_url: `${origin}/app/settings?plan_changed=1`,
        });
        window.location.href = url;
        return;
      }

      const { url } = await startCheckout({
        price_id: priceId,
        success_url: `${origin}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${origin}/pricing?canceled=1`,
        coupon: founderActive ? founderOffer!.code : null,
      });
      window.location.href = url;
    } catch (e) {
      setErr(formatErr(e));
      setBusyPlanId(null);
    }
  };

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {/* Top bar — minimal back link */}
      <div className="border-b border-neutral-900">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Link
            to={isAuthed ? "/app" : "/"}
            className="text-sm text-neutral-400 hover:text-white transition flex items-center gap-2"
          >
            <span aria-hidden>←</span>
            {isAuthed ? "Back to app" : "Back to home"}
          </Link>
          {isAuthed && me?.email && (
            <div className="text-xs text-neutral-500 truncate max-w-[60%]">
              Signed in as {me.email}
            </div>
          )}
        </div>
      </div>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
        {/* Hero */}
        <div className="text-center max-w-2xl mx-auto space-y-4">
          {isLockedAccount && (
            <div className="inline-flex rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-200 px-3 py-1 text-xs font-medium">
              Your trial has ended — pick a plan to continue
            </div>
          )}
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight">
            Pricing built for{" "}
            <span className="bg-gradient-to-r from-violet-400 to-fuchsia-400 bg-clip-text text-transparent">
              print shops
            </span>
            , not software vendors.
          </h1>
          <p className="text-neutral-400 text-base sm:text-lg leading-relaxed">
            One predictable monthly fee. No per-seat traps, no per-export
            charges. Cancel any time, keep your work.
          </p>
        </div>

        {/* Cadence toggle */}
        <div className="mt-8 flex justify-center">
          <div
            role="tablist"
            aria-label="Billing cadence"
            className="inline-flex rounded-full border border-neutral-800 bg-neutral-900/40 p-1"
          >
            <CadenceButton
              active={cadence === "monthly"}
              onClick={() => setCadence("monthly")}
            >
              Monthly
            </CadenceButton>
            <CadenceButton
              active={cadence === "annual"}
              onClick={() => setCadence("annual")}
              hint={data?.plans[0]?.annual_save_pct ?? 0}
            >
              Annual
            </CadenceButton>
          </div>
        </div>

        {err && (
          <div className="mt-6 max-w-xl mx-auto rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
            {err}
          </div>
        )}

        {/* Plan cards */}
        <div className="mt-10 grid gap-5 sm:grid-cols-3">
          {data === null && !err
            ? Array.from({ length: 3 }).map((_, i) => (
                <PlanCardSkeleton key={i} />
              ))
            : data?.plans.map((p) => (
                <PlanCard
                  key={p.id}
                  plan={p}
                  cadence={cadence}
                  founderOffer={founderActive ? founderOffer : null}
                  busy={busyPlanId === p.id}
                  isCurrentPlan={
                    me?.stripe_subscription_status === "active" &&
                    matchesPlan(me.stripe_price_id, p)
                  }
                  isExistingSubscriber={hasLiveSubscription}
                  onSelect={() => onSelectPlan(p)}
                />
              ))}
        </div>

        {/* Enterprise card */}
        <div className="mt-5 rounded-2xl border border-neutral-800 bg-gradient-to-br from-neutral-900/60 to-neutral-950 p-6 sm:p-8 flex flex-col sm:flex-row items-start sm:items-center gap-5 justify-between">
          <div className="space-y-2 max-w-xl">
            <div className="text-xs uppercase tracking-wider text-neutral-500">
              Enterprise
            </div>
            <h3 className="text-xl font-semibold">
              Multi-site, multi-seat, custom workflows.
            </h3>
            <p className="text-sm text-neutral-400">
              Volume contracts for franchises, large print networks, and OEMs
              shipping printers with PrintLay built in. Dedicated onboarding,
              priority engineering, single-tenant deployment optional.
            </p>
          </div>
          <a
            href={`mailto:${
              data?.enterprise_contact_email ?? "hello@printlay.io"
            }?subject=PrintLay%20Enterprise`}
            className="shrink-0 rounded-lg border border-neutral-700 bg-neutral-900/50 px-5 py-3 text-sm font-semibold hover:border-neutral-500 transition"
          >
            Talk to us →
          </a>
        </div>

        {/* Trust strip */}
        <div className="mt-12 grid sm:grid-cols-3 gap-5 text-sm">
          <TrustItem
            title="Cancel any time"
            body="Self-serve in the customer portal. No phone calls, no win-back gauntlet."
          />
          <TrustItem
            title="Your work stays yours"
            body="Templates, artwork, colour profiles — exportable and downloadable, always."
          />
          <TrustItem
            title="Built by print people"
            body="Designed alongside operating UV and DTF shops, not in a vacuum."
          />
        </div>

        {/* Founder strip */}
        {founderActive && founderOffer && (
          <div className="mt-10 rounded-2xl border border-violet-500/30 bg-gradient-to-r from-violet-500/10 via-fuchsia-500/5 to-transparent p-6 sm:p-7">
            <div className="flex items-start gap-4 flex-col sm:flex-row">
              <div className="rounded-full bg-violet-500/20 border border-violet-400/40 px-3 py-1 text-xs font-semibold text-violet-200 shrink-0">
                Launch offer
              </div>
              <div className="space-y-1.5">
                <h3 className="font-semibold">
                  Founder Offer — {founderOffer.discount_pct}% off forever
                </h3>
                <p className="text-sm text-neutral-400">
                  Prices above already reflect the discount. Subscribe before
                  midnight on {founderOffer.ends_at_label} and we'll keep{" "}
                  {founderOffer.discount_pct}% off your plan for the life of
                  your subscription, plus a permanent{" "}
                  <span className="text-violet-300">Founder</span> badge. Code{" "}
                  <code className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-200">
                    {founderOffer.code}
                  </code>{" "}
                  applies automatically at checkout. The discount is a{" "}
                  {founderOffer.discount_pct}% reduction off the published rate
                  at the time of each renewal — see our{" "}
                  <Link
                    to="/terms"
                    className="underline hover:text-neutral-200"
                  >
                    terms
                  </Link>{" "}
                  for the full details. No second chances after{" "}
                  {founderOffer.ends_at_label}.
                </p>
              </div>
            </div>
          </div>
        )}

        <div className="mt-10 text-center text-xs text-neutral-600">
          Prices shown in GBP, exclusive of local taxes. Card billing through
          Stripe — your card details never touch our servers.
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PlanCard({
  plan,
  cadence,
  founderOffer,
  busy,
  isCurrentPlan,
  isExistingSubscriber,
  onSelect,
}: {
  plan: PlanItem;
  cadence: Cadence;
  /** When set, we show strike-through pricing and the "−N%" pill. */
  founderOffer: FounderOffer | null;
  busy: boolean;
  isCurrentPlan: boolean;
  isExistingSubscriber: boolean;
  onSelect: () => void;
}) {
  const listPrice =
    cadence === "annual"
      ? plan.annual_price_display
      : plan.monthly_price_display;
  const effectivePrice =
    founderOffer
      ? cadence === "annual"
        ? plan.effective_annual_display
        : plan.effective_monthly_display
      : null;
  const headlinePrice = effectivePrice ?? listPrice;
  const periodLabel = cadence === "annual" ? "/year" : "/month";

  // Compute "≈ £X / month, billed yearly" using whichever annual price
  // the customer is actually charged (effective during a launch offer,
  // list price otherwise). Prevents the helper text from contradicting
  // the headline price.
  const monthlyEquivalent = useMemo(() => {
    if (cadence !== "annual") return null;
    const annualStr = effectivePrice ?? plan.annual_price_display;
    const cleaned = annualStr.replace(/[^0-9.]/g, "");
    const annual = Number(cleaned);
    if (!annual || isNaN(annual)) return null;
    const symbol = annualStr.replace(/[0-9.,]/g, "").trim();
    const perMonth = annual / 12;
    const perMonthStr =
      perMonth >= 100 ? perMonth.toFixed(0) : perMonth.toFixed(2);
    return `${symbol}${perMonthStr} / month, billed yearly`;
  }, [cadence, plan.annual_price_display, effectivePrice]);

  const popular = plan.most_popular;

  return (
    <div
      className={`relative rounded-2xl border p-6 flex flex-col ${
        popular
          ? "border-violet-500/50 bg-gradient-to-b from-violet-500/10 to-neutral-900/60 shadow-xl shadow-violet-500/10"
          : "border-neutral-800 bg-neutral-900/40"
      }`}
    >
      {popular && (
        <div className="absolute -top-3 left-1/2 -translate-x-1/2">
          <span className="rounded-full bg-gradient-to-r from-violet-500 to-fuchsia-500 px-3 py-1 text-xs font-semibold text-white shadow-lg">
            Most popular
          </span>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <h3 className="text-lg font-semibold">{plan.name}</h3>
        {isCurrentPlan && (
          <span className="text-[10px] uppercase tracking-wider text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded-full px-2 py-0.5">
            Current
          </span>
        )}
      </div>
      <p className="text-sm text-neutral-400 min-h-[2.5rem]">{plan.tagline}</p>

      <div className="mt-5">
        {effectivePrice && founderOffer && (
          <div className="flex items-center gap-2 mb-1">
            <span className="text-base text-neutral-500 line-through decoration-neutral-600">
              {listPrice}
            </span>
            <span className="rounded-full border border-violet-400/40 bg-violet-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-violet-200">
              −{founderOffer.discount_pct}%
            </span>
          </div>
        )}
        <div className="flex items-baseline gap-1">
          <span className="text-4xl font-bold tracking-tight">
            {headlinePrice}
          </span>
          <span className="text-neutral-500 text-sm">{periodLabel}</span>
        </div>
        {monthlyEquivalent && (
          <div className="text-xs text-neutral-500 mt-1">
            {monthlyEquivalent}
          </div>
        )}
        {effectivePrice && founderOffer && (
          <div className="text-[11px] text-violet-300/80 mt-1.5">
            Founder pricing — code applied automatically at checkout
          </div>
        )}
      </div>

      <ul className="mt-6 space-y-2.5 text-sm flex-1">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2">
            <CheckIcon />
            <span className="text-neutral-300">{f}</span>
          </li>
        ))}
      </ul>

      <button
        onClick={onSelect}
        disabled={busy || isCurrentPlan}
        className={`mt-7 w-full rounded-lg py-3 text-sm font-semibold transition disabled:opacity-50 ${
          popular
            ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20"
            : "bg-white text-neutral-950 hover:bg-neutral-200"
        }`}
      >
        {isCurrentPlan
          ? "You're on this plan"
          : busy
          ? isExistingSubscriber
            ? "Opening portal…"
            : "Opening checkout…"
          : isExistingSubscriber
          ? `Switch to ${plan.name}`
          : `Choose ${plan.name}`}
      </button>
    </div>
  );
}

function PlanCardSkeleton() {
  return (
    <div className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 animate-pulse">
      <div className="h-5 w-24 bg-neutral-800 rounded mb-3" />
      <div className="h-3 w-40 bg-neutral-800 rounded mb-6" />
      <div className="h-9 w-28 bg-neutral-800 rounded mb-6" />
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-3 w-full bg-neutral-800 rounded" />
        ))}
      </div>
      <div className="mt-7 h-11 w-full bg-neutral-800 rounded-lg" />
    </div>
  );
}

function CadenceButton({
  active,
  onClick,
  children,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  hint?: number;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative rounded-full px-5 py-2 text-sm font-medium transition ${
        active
          ? "bg-white text-neutral-950"
          : "text-neutral-400 hover:text-white"
      }`}
    >
      {children}
      {hint !== undefined && hint > 0 && !active && (
        <span className="ml-2 text-[10px] font-semibold text-emerald-300">
          Save {hint}%
        </span>
      )}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg
      className="w-4 h-4 mt-0.5 shrink-0 text-violet-400"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 8.5l3.2 3 6.8-7.5" />
    </svg>
  );
}

function TrustItem({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-4">
      <div className="text-sm font-semibold mb-1">{title}</div>
      <div className="text-xs text-neutral-500 leading-relaxed">{body}</div>
    </div>
  );
}

// Exact match: the user's active price ID matches one of the plan's prices.
function matchesPlan(stripePriceId: string | null | undefined, plan: PlanItem): boolean {
  if (!stripePriceId) return false;
  return (
    stripePriceId === plan.monthly_price_id ||
    stripePriceId === plan.annual_price_id
  );
}

