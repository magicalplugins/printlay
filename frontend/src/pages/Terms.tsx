import { Link } from "react-router-dom";
import LandingNav from "../components/landing/LandingNav";
import LandingFooter from "../components/landing/LandingFooter";

/**
 * Terms & Conditions.
 *
 * The single most important clause here is §6 (Founder Offer): it nails
 * down that the discount is a **percentage off the published price**,
 * not a price lock. Without that, raising headline prices later would
 * trap us into a permanent legal risk with founder accounts. With it,
 * we can move headline prices freely and founders simply continue to
 * receive the agreed percentage discount on the new price.
 *
 * Plain English on purpose. Heavy legalese on a £25/mo SaaS scares more
 * shops than it protects.
 */
const LAST_UPDATED = "26 April 2026";

export default function Terms() {
  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <LandingNav />

      <article className="mx-auto max-w-3xl px-6 py-20 sm:py-28">
        <header className="mb-12 space-y-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500">
            Legal
          </div>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight">
            Terms &amp; Conditions
          </h1>
          <p className="text-sm text-neutral-500">
            Last updated: {LAST_UPDATED}
          </p>
          <p className="text-neutral-400 leading-relaxed">
            These are the terms that govern your use of Printlay. They're
            written in plain English so you can actually read them. If
            anything is unclear, email{" "}
            <a
              href="mailto:hello@printlay.com"
              className="underline hover:text-white"
            >
              hello@printlay.com
            </a>{" "}
            and we'll explain.
          </p>
        </header>

        <div className="space-y-12 text-neutral-300 leading-relaxed">
          <Section number="1" title="Who we are">
            <p>
              "Printlay", "we", "us" and "our" mean the entity operating the
              Printlay service at{" "}
              <a
                href="https://printlay.com"
                className="underline hover:text-white"
              >
                printlay.com
              </a>
              . "You" means the person or business using the service.
            </p>
            <p>
              By signing up for an account, accessing the service, or
              entering into a paid subscription, you agree to be bound by
              these terms.
            </p>
          </Section>

          <Section number="2" title="What Printlay does">
            <p>
              Printlay is a SaaS tool for print shops that helps you take a
              gang-sheet template, fill its slots from a catalogue of artwork,
              apply colour swaps, and export print-ready PDFs. We provide the
              software and the hosted infrastructure; you provide the
              artwork, templates and the print equipment.
            </p>
            <p>
              We don't manufacture, ship or warrant any physical print
              output. The PDF is the product we're responsible for; what
              happens on press is your domain.
            </p>
          </Section>

          <Section number="3" title="Trial">
            <p>
              Every new account starts with a 14-day full-access trial. No
              card is required to begin. During the trial you have access to
              the Pro feature set with a 1 GB total storage allowance.
            </p>
            <p>
              When the trial ends, the account moves to a locked state until
              a paid subscription begins. Your templates, artwork, jobs and
              colour profiles remain on file and are restored the moment you
              pick a plan.
            </p>
          </Section>

          <Section number="4" title="Subscriptions and billing">
            <ul className="space-y-3 list-disc pl-5">
              <li>
                Paid plans (Starter, Pro, Studio) are billed in advance,
                either monthly or annually, through Stripe. We don't store
                card numbers — Stripe does.
              </li>
              <li>
                Annual plans renew on the same day each year; monthly plans
                renew on the same day each month. Renewals are automatic
                until you cancel.
              </li>
              <li>
                You can cancel at any time from{" "}
                <span className="text-neutral-200">Settings → Account</span>.
                Cancellation stops future renewals; the current period plays
                out and you keep access until the period ends.
              </li>
              <li>
                Refunds are not issued for partially-used periods. We'll
                gladly resolve genuine billing errors — email{" "}
                <a
                  href="mailto:billing@printlay.com"
                  className="underline hover:text-white"
                >
                  billing@printlay.com
                </a>
                .
              </li>
              <li>
                Prices are in GBP, exclusive of VAT and other local taxes.
                Stripe applies the tax appropriate to your billing location
                at checkout.
              </li>
            </ul>
          </Section>

          <Section number="5" title="Price changes">
            <p>
              We may change the published price of any plan from time to
              time. We'll do this by updating the{" "}
              <Link to="/pricing" className="underline hover:text-white">
                pricing page
              </Link>{" "}
              and emailing affected customers at least 30 days before the
              new price takes effect on a renewal.
            </p>
            <p>
              If you don't accept a new price you can cancel before your
              next renewal and avoid being charged at the new rate. Your
              existing period is honoured at the price you were last
              charged.
            </p>
          </Section>

          <Section
            number="6"
            title="Founder Offer (FOUNDERS50) — important"
            highlight
          >
            <p>
              The Founder Offer is a <strong>50% percentage discount</strong>{" "}
              applied to whichever Printlay plan you subscribe to. To
              qualify you must start a paid subscription before midnight
              (UK time) on <strong>30 July 2026</strong> using the coupon{" "}
              <code className="rounded bg-neutral-900 px-1.5 py-0.5 text-xs text-neutral-200">
                FOUNDERS50
              </code>{" "}
              (which we apply automatically while the offer is live).
            </p>
            <p>
              Once you qualify, the 50% discount continues to apply for the
              lifetime of an unbroken subscription, including across plan
              changes (upgrades and downgrades). Provided your subscription
              remains continuously active, you keep the discount on each
              renewal.
            </p>
            <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-amber-100">
              <strong>What "lifetime" means here:</strong> the Founder Offer
              locks in a <em>percentage discount</em> off the published
              Printlay price at the time of each renewal. It is{" "}
              <strong>not</strong> a price lock and does not freeze the
              underlying plan price. If we change the published price of a
              plan in line with §5, your future renewals are charged at 50%
              of the new published price, not 50% of the price at the time
              you signed up.
            </p>
            <p>
              The Founder discount does not stack with other promotional
              codes. If you cancel and later resubscribe after the offer
              has closed, the discount does not reactivate. Founder badges
              shown in the app are cosmetic and have no separate
              entitlement.
            </p>
            <p>
              We reserve the right to end the Founder Offer earlier than 30
              July 2026 if circumstances require it; existing Founder
              subscriptions in good standing will continue to receive the
              discount under the rules above.
            </p>
          </Section>

          <Section number="7" title="Acceptable use">
            <p>You agree not to:</p>
            <ul className="space-y-2 list-disc pl-5">
              <li>
                Upload artwork you don't have the right to print, or that is
                unlawful, infringing, defamatory or harmful.
              </li>
              <li>
                Attempt to circumvent quotas, rate limits or storage caps
                applied to your plan.
              </li>
              <li>
                Reverse-engineer, scrape, resell or sublicense the service
                without our written consent.
              </li>
              <li>
                Use the service to send unsolicited communications or to
                harass other users.
              </li>
            </ul>
            <p>
              We may suspend or terminate accounts that breach these rules.
              Where possible we'll give you a chance to fix the issue first.
            </p>
          </Section>

          <Section number="8" title="Your data, your artwork">
            <p>
              You retain all intellectual property rights in the templates,
              artwork, jobs and outputs you create with Printlay. We claim
              no ownership of your content.
            </p>
            <p>
              You grant us a limited, non-exclusive licence to host,
              process, render, transform and display your content solely as
              needed to operate the service for you (for example, to convert
              uploaded files, generate previews, and produce PDF outputs).
            </p>
            <p>
              We use Cloudflare R2 for storage and Supabase for application
              data. We do not sell your content, and we do not use it to
              train machine-learning models.
            </p>
          </Section>

          <Section number="9" title="Storage and quotas">
            <p>
              Each plan publishes per-file and total-storage limits on the{" "}
              <Link to="/pricing" className="underline hover:text-white">
                pricing page
              </Link>
              . Generated PDF outputs do not count toward your storage
              total; uploaded artwork (catalogue + job-attached) does.
            </p>
            <p>
              If you exceed a quota the service will tell you and offer the
              choice to free up space or upgrade. We don't auto-delete your
              data when a quota is exceeded.
            </p>
            <p>
              When an account is closed (by you or by us for breach), we
              will retain your data for up to 30 days to allow recovery,
              then permanently delete it.
            </p>
          </Section>

          <Section number="10" title="Service availability">
            <p>
              We aim for 99.5% monthly availability but do not guarantee
              uninterrupted service. Scheduled maintenance and force-majeure
              events excepted. We may make changes to features, limits and
              integrations to improve the service.
            </p>
          </Section>

          <Section number="11" title="Liability">
            <p>
              To the maximum extent permitted by law, our aggregate
              liability under or in connection with these terms is limited
              to the amount you have paid us for the service in the 12
              months preceding the event giving rise to the claim. We are
              not liable for indirect, incidental, consequential or special
              damages, including loss of profit, business interruption or
              loss of data.
            </p>
            <p>
              Nothing in these terms excludes liability for death or
              personal injury caused by negligence, fraud, or any liability
              that cannot be excluded under English law.
            </p>
          </Section>

          <Section number="12" title="Privacy">
            <p>
              We collect the minimum data needed to operate the service
              (your email, account preferences, and the content you upload).
              We use Stripe for billing and Supabase for auth; both are
              GDPR-compliant processors. We do not sell or rent your
              personal information.
            </p>
            <p>
              For full details, see our privacy notice (or email{" "}
              <a
                href="mailto:privacy@printlay.com"
                className="underline hover:text-white"
              >
                privacy@printlay.com
              </a>
              ).
            </p>
          </Section>

          <Section number="13" title="Changes to these terms">
            <p>
              We may update these terms from time to time. Material changes
              (anything that affects pricing, the Founder Offer, your data
              rights, or your liability) will be communicated by email at
              least 30 days before they take effect on your account.
            </p>
            <p>
              Continued use of the service after the effective date of an
              update means you accept the updated terms.
            </p>
          </Section>

          <Section number="14" title="Governing law">
            <p>
              These terms are governed by the laws of England and Wales.
              Any dispute will be resolved in the courts of England and
              Wales, except that we may bring an action in any jurisdiction
              where you reside.
            </p>
          </Section>
        </div>

        <div className="mt-16 border-t border-neutral-900 pt-8 text-sm text-neutral-500">
          Questions about these terms? Email{" "}
          <a
            href="mailto:hello@printlay.com"
            className="underline hover:text-neutral-200"
          >
            hello@printlay.com
          </a>
          .
        </div>
      </article>

      <LandingFooter />
    </div>
  );
}

function Section({
  number,
  title,
  highlight = false,
  children,
}: {
  number: string;
  title: string;
  highlight?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        highlight
          ? "rounded-2xl border border-violet-500/30 bg-violet-500/5 px-6 py-7 sm:px-8"
          : ""
      }
      id={`s${number}`}
    >
      <h2 className="mb-4 flex items-baseline gap-3 text-xl sm:text-2xl font-semibold tracking-tight text-white">
        <span className="font-mono text-xs uppercase tracking-widest text-neutral-500">
          §{number}
        </span>
        {title}
      </h2>
      <div className="space-y-4">{children}</div>
    </section>
  );
}
