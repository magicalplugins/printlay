import { Link } from "react-router-dom";
import Seo from "../../components/Seo";
import MarketingShell from "../../components/marketing/MarketingShell";
import Breadcrumbs from "../../components/marketing/Breadcrumbs";
import CtaBlock from "../../components/marketing/CtaBlock";
import { TOOLS } from "../../content/tools";
import { breadcrumbLd } from "../../content/schema";

/** Index of the free tools. */
export default function ToolsIndex() {
  const trail = [
    { name: "Home", path: "/" },
    { name: "Tools", path: "/tools" },
  ];
  return (
    <MarketingShell>
      <Seo
        title="Free Tools for Print Shops — Gang Sheet, Bleed & DPI | Printlay"
        description="Free calculators for print shops: gang sheet fit and cost calculator, plus a bleed, DPI and mm/inch converter. No sign-up required."
        path="/tools"
        jsonLd={breadcrumbLd(trail)}
      />
      <div className="mx-auto max-w-4xl">
        <Breadcrumbs trail={trail} />
        <header className="max-w-2xl">
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-white">
            Free print shop tools
          </h1>
          <p className="mt-3 text-neutral-400">
            Quick calculators for everyday print prep. No sign-up, no catch.
          </p>
        </header>
        <div className="mt-10 grid gap-4 sm:grid-cols-2">
          {TOOLS.map((t) => (
            <Link
              key={t.slug}
              to={`/tools/${t.slug}`}
              className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 transition hover:border-neutral-600"
            >
              <div className="text-[11px] font-semibold uppercase tracking-widest text-violet-300">
                Free tool
              </div>
              <h2 className="mt-2 text-lg font-semibold text-neutral-100">
                {t.h1}
              </h2>
              <p className="mt-2 flex-1 text-sm text-neutral-400">{t.blurb}</p>
              <span className="mt-4 text-sm font-medium text-violet-400">
                Open tool →
              </span>
            </Link>
          ))}
        </div>
        <CtaBlock />
      </div>
    </MarketingShell>
  );
}
