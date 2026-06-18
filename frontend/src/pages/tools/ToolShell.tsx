import type { ReactNode } from "react";
import Seo from "../../components/Seo";
import MarketingShell from "../../components/marketing/MarketingShell";
import Breadcrumbs from "../../components/marketing/Breadcrumbs";
import CtaBlock from "../../components/marketing/CtaBlock";
import { breadcrumbLd, faqLd } from "../../content/schema";
import type { ToolMeta } from "../../content/tools";
import type { FaqItem } from "../../content/types";

/** Common chrome for a free tool page: SEO, breadcrumb, H1, intro, FAQ, CTA. */
export default function ToolShell({
  tool,
  intro,
  children,
  about,
  faq,
}: {
  tool: ToolMeta;
  intro: string;
  children: ReactNode;
  about?: ReactNode;
  faq?: FaqItem[];
}) {
  const path = `/tools/${tool.slug}`;
  const trail = [
    { name: "Home", path: "/" },
    { name: "Tools", path: "/tools" },
    { name: tool.h1, path },
  ];
  const jsonLd: object[] = [breadcrumbLd(trail)];
  if (faq?.length) jsonLd.push(faqLd(faq));

  return (
    <MarketingShell>
      <Seo
        title={tool.title}
        description={tool.description}
        path={path}
        jsonLd={jsonLd}
      />
      <div className="mx-auto max-w-3xl">
        <Breadcrumbs trail={trail} />
        <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-300">
          Free tool
        </div>
        <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold leading-tight tracking-tight text-white">
          {tool.h1}
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-neutral-400">{intro}</p>

        <div className="mt-8">{children}</div>

        {about && <div className="article-content mt-14">{about}</div>}

        {faq?.length ? (
          <section className="mt-14">
            <h2 className="text-2xl font-bold tracking-tight text-white">
              Frequently asked questions
            </h2>
            <div className="mt-5 divide-y divide-neutral-900 border-y border-neutral-900">
              {faq.map((f) => (
                <details key={f.q} className="group py-4">
                  <summary className="cursor-pointer list-none text-base font-medium text-neutral-100">
                    <span className="flex items-start justify-between gap-4">
                      {f.q}
                      <span className="mt-1 text-neutral-500 transition group-open:rotate-45">
                        +
                      </span>
                    </span>
                  </summary>
                  <p className="mt-2 text-sm leading-relaxed text-neutral-400">
                    {f.a}
                  </p>
                </details>
              ))}
            </div>
          </section>
        ) : null}

        <CtaBlock />
      </div>
    </MarketingShell>
  );
}

/** Shared field styling for the tool forms. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium text-neutral-300">{label}</span>
      {hint && <span className="ml-1 text-xs text-neutral-600">{hint}</span>}
      <div className="mt-1.5">{children}</div>
    </label>
  );
}

export const inputClass =
  "w-full rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2.5 text-sm text-neutral-100 outline-none transition focus:border-violet-500";
