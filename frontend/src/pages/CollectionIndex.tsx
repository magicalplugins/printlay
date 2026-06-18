import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import MarketingShell from "../components/marketing/MarketingShell";
import Breadcrumbs from "../components/marketing/Breadcrumbs";
import CtaBlock from "../components/marketing/CtaBlock";
import { listDocs } from "../content/registry";
import { COLLECTION_META } from "../content/collections";
import { breadcrumbLd } from "../content/schema";
import type { Collection } from "../content/types";

/**
 * Listing page for a content collection (/guides, /blog, /glossary, /compare).
 * Glossary renders as a compact term grid; others render as article cards.
 */
export default function CollectionIndex({
  collection,
}: {
  collection: Collection;
}) {
  const meta = COLLECTION_META[collection];
  const docs = listDocs(collection);
  const isGlossary = collection === "glossary";
  const trail = [
    { name: "Home", path: "/" },
    { name: meta.label, path: meta.path },
  ];

  return (
    <MarketingShell>
      <Seo
        title={meta.title}
        description={meta.description}
        path={meta.path}
        jsonLd={breadcrumbLd(trail)}
      />

      <div className="mx-auto max-w-4xl">
        <Breadcrumbs trail={trail} />
        <header className="max-w-2xl">
          <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold tracking-tight text-white">
            {meta.label}
          </h1>
          <p className="mt-3 text-neutral-400">{meta.description}</p>
        </header>

        {isGlossary ? (
          <div className="mt-10 grid gap-3 sm:grid-cols-2">
            {docs.map((d) => (
              <Link
                key={d.path}
                to={d.path}
                className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-600"
              >
                <div className="text-sm font-semibold text-neutral-100">
                  {d.frontmatter.h1 || d.frontmatter.title}
                </div>
                <div className="mt-1 line-clamp-2 text-xs text-neutral-500">
                  {d.frontmatter.excerpt || d.frontmatter.description}
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <div className="mt-10 grid gap-4 sm:grid-cols-2">
            {docs.map((d) => (
              <Link
                key={d.path}
                to={d.path}
                className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 transition hover:border-neutral-600"
              >
                {d.frontmatter.category && (
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-violet-300">
                    {d.frontmatter.category}
                  </div>
                )}
                <h2 className="mt-2 text-lg font-semibold text-neutral-100">
                  {d.frontmatter.h1 || d.frontmatter.title}
                </h2>
                <p className="mt-2 flex-1 text-sm text-neutral-400">
                  {d.frontmatter.excerpt || d.frontmatter.description}
                </p>
                <span className="mt-4 text-sm font-medium text-violet-400">
                  Read more →
                </span>
              </Link>
            ))}
          </div>
        )}

        {docs.length === 0 && (
          <p className="mt-10 text-neutral-500">Nothing here yet — check back soon.</p>
        )}

        <CtaBlock />
      </div>
    </MarketingShell>
  );
}
