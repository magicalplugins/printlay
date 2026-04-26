import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { motion } from "framer-motion";
import {
  getPlans,
  type FounderOffer,
  type PlanItem,
} from "../../api/billing";

// Visual treatment per plan. Data (price, features, copy) comes from the
// /api/billing/plans endpoint so this component stays in sync with the
// real /pricing page and the backend `_PLAN_DISPLAY` source of truth.
type Treatment = {
  accent: string;
  border: string;
  highlight: boolean;
};

const TREATMENT: Record<PlanItem["id"], Treatment> = {
  starter: {
    accent: "from-sky-500 to-indigo-500",
    border: "border-neutral-800",
    highlight: false,
  },
  pro: {
    accent: "from-violet-500 to-fuchsia-500",
    border: "border-violet-500/40",
    highlight: true,
  },
  studio: {
    accent: "from-amber-400 to-orange-500",
    border: "border-neutral-800",
    highlight: false,
  },
};

// Fallback values match `_PLAN_DISPLAY` in backend/routers/billing.py.
// Kept here only so the section never renders blank if the API is slow
// or briefly unreachable. The API response always wins.
const FALLBACK_PLANS: PlanItem[] = [
  {
    id: "starter",
    name: "Starter",
    monthly_price_id: null,
    annual_price_id: null,
    monthly_price_display: "£25",
    annual_price_display: "£250",
    effective_monthly_display: "£12.50",
    effective_annual_display: "£125",
    annual_save_pct: 17,
    tagline: "For solo print operators getting started.",
    features: [
      "5 templates",
      "200 PDF exports / month",
      "Up to 50 MB per artwork",
      "5 GB total storage",
    ],
    most_popular: false,
  },
  {
    id: "pro",
    name: "Pro",
    monthly_price_id: null,
    annual_price_id: null,
    monthly_price_display: "£49",
    annual_price_display: "£490",
    effective_monthly_display: "£24.50",
    effective_annual_display: "£245",
    annual_save_pct: 17,
    tagline: "For working print shops. Most popular.",
    features: [
      "Unlimited templates",
      "Unlimited PDF exports",
      "Up to 100 MB per artwork",
      "50 GB total storage",
    ],
    most_popular: true,
  },
  {
    id: "studio",
    name: "Studio",
    monthly_price_id: null,
    annual_price_id: null,
    monthly_price_display: "£99",
    annual_price_display: "£990",
    effective_monthly_display: "£49.50",
    effective_annual_display: "£495",
    annual_save_pct: 17,
    tagline: "For high-volume production with custom workflows.",
    features: [
      "Everything in Pro",
      "Up to 500 MB per artwork",
      "250 GB total storage",
      "API access",
    ],
    most_popular: false,
  },
];

const FALLBACK_FOUNDER_OFFER: FounderOffer = {
  active: true,
  code: "FOUNDERS50",
  discount_pct: 50,
  ends_at: "2026-07-30T23:59:59+00:00",
  ends_at_label: "30 July 2026",
};

// Trim the full feature list down to the 4 most marketing-impactful items
// for the landing-page preview. The /pricing page shows the full list.
function previewFeatures(features: string[]): string[] {
  return features.slice(0, 4);
}

export default function PricingPreview() {
  const [plans, setPlans] = useState<PlanItem[]>(FALLBACK_PLANS);
  const [founderOffer, setFounderOffer] = useState<FounderOffer>(
    FALLBACK_FOUNDER_OFFER
  );

  useEffect(() => {
    let cancelled = false;
    getPlans()
      .then((res) => {
        if (cancelled) return;
        if (Array.isArray(res.plans) && res.plans.length > 0) {
          setPlans(res.plans);
        }
        if (res.founder_offer) {
          setFounderOffer(res.founder_offer);
        }
      })
      .catch(() => {
        // Silent — the fallback plans are always shown.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const founderActive = founderOffer.active;

  return (
    <section className="relative px-6 py-32 border-t border-neutral-900">
      <div className="max-w-6xl mx-auto space-y-16">
        {/* Header */}
        <div className="text-center space-y-4">
          <div className="text-xs uppercase tracking-widest text-neutral-500">
            Pricing
          </div>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight">
            Simple plans for{" "}
            <span className="italic font-light">serious shops.</span>
          </h2>
          <p className="text-neutral-400 text-lg max-w-xl mx-auto">
            Every plan starts with a 14-day full-access trial — no card needed.
            Upgrade once you see the time you're saving.
          </p>
        </div>

        {/* Founder banner */}
        {founderActive && (
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="relative overflow-hidden rounded-2xl border border-amber-500/30 bg-amber-500/10 px-6 py-5 flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6"
          >
            <div className="flex-shrink-0 text-2xl">⚡</div>
            <div className="space-y-1 flex-1">
              <p className="font-semibold text-amber-200 tracking-tight">
                Founder Offer — {founderOffer.discount_pct}% off forever
              </p>
              <p className="text-sm text-amber-200/60">
                Prices below already reflect the discount. Locked in for the
                life of your subscription. Closes midnight,{" "}
                {founderOffer.ends_at_label} — no second chances.{" "}
                <Link to="/terms" className="underline hover:text-amber-100">
                  Terms
                </Link>
                .
              </p>
            </div>
            <Link
              to="/register"
              className="flex-shrink-0 rounded-xl bg-amber-400 px-5 py-2.5 text-sm font-semibold text-amber-950 hover:bg-amber-300 transition"
            >
              Claim your spot →
            </Link>
          </motion.div>
        )}

        {/* Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan, i) => {
            const t = TREATMENT[plan.id] ?? TREATMENT.starter;
            const features = previewFeatures(plan.features);
            return (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className={`relative rounded-2xl border ${t.border} bg-neutral-900/60 p-7 flex flex-col gap-6 ${
                  t.highlight ? "ring-1 ring-violet-500/40" : ""
                }`}
              >
                {plan.most_popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-violet-600 px-3 py-0.5 text-[10px] uppercase tracking-widest text-white font-semibold">
                    Most popular
                  </div>
                )}
                <div className="space-y-2">
                  <div
                    className={`text-xs font-mono uppercase tracking-widest text-transparent bg-clip-text bg-gradient-to-r ${t.accent}`}
                  >
                    {plan.name}
                  </div>
                  {founderActive && plan.effective_monthly_display ? (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-base text-neutral-500 line-through decoration-neutral-600">
                          {plan.monthly_price_display}
                        </span>
                        <span className="rounded-full border border-amber-400/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                          −{founderOffer.discount_pct}%
                        </span>
                      </div>
                      <div className="flex items-end gap-1">
                        <span className="text-4xl font-bold">
                          {plan.effective_monthly_display}
                        </span>
                        <span className="text-neutral-400 mb-1">/mo</span>
                      </div>
                      <p className="text-[11px] text-amber-200/70">
                        Founder pricing — auto-applied at checkout
                      </p>
                    </div>
                  ) : (
                    <div className="flex items-end gap-1">
                      <span className="text-4xl font-bold">
                        {plan.monthly_price_display}
                      </span>
                      <span className="text-neutral-400 mb-1">/mo</span>
                    </div>
                  )}
                  <p className="text-sm text-neutral-400">{plan.tagline}</p>
                </div>

                <ul className="space-y-2.5 flex-1">
                  {features.map((f) => (
                    <li
                      key={f}
                      className="flex items-start gap-2.5 text-sm text-neutral-300"
                    >
                      <span
                        className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded-full bg-gradient-to-br ${t.accent} flex items-center justify-center`}
                      >
                        <svg
                          className="w-2.5 h-2.5 text-white"
                          viewBox="0 0 10 10"
                          fill="none"
                        >
                          <path
                            d="M2 5l2.5 2.5L8 3"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </span>
                      {f}
                    </li>
                  ))}
                </ul>

                <Link
                  to="/register"
                  className={`w-full rounded-xl py-3 text-sm font-semibold text-center transition ${
                    t.highlight
                      ? "bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400"
                      : "border border-neutral-700 text-neutral-200 hover:border-neutral-500"
                  }`}
                >
                  Start free trial →
                </Link>
              </motion.div>
            );
          })}
        </div>

        <div className="text-center">
          <Link
            to="/pricing"
            className="text-sm text-neutral-400 hover:text-white underline underline-offset-4 transition"
          >
            See full pricing — annual plans, Enterprise & feature comparison →
          </Link>
        </div>
      </div>
    </section>
  );
}
