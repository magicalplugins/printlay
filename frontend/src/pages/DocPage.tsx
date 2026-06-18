import { Link, useParams } from "react-router-dom";
import Seo from "../components/Seo";
import MarketingShell from "../components/marketing/MarketingShell";
import Breadcrumbs from "../components/marketing/Breadcrumbs";
import CtaBlock from "../components/marketing/CtaBlock";
import { getDoc, resolveRelated } from "../content/registry";
import { COLLECTION_META } from "../content/collections";
import { articleLd, breadcrumbLd, faqLd } from "../content/schema";
import type { Collection } from "../content/types";

/**
 * Renders a single Markdown doc (guide / blog / glossary / compare / feature).
 * The collection is fixed by the route; the slug comes from the URL.
 */
export default function DocPage({ collection }: { collection: Collection }) {
  const { slug = "" } = useParams();
  const doc = getDoc(collection, slug);
  const meta = COLLECTION_META[collection];

  if (!doc) {
    return (
      <MarketingShell>
        <Seo
          title="Not found — Printlay"
          description="The page you were looking for doesn't exist."
          path={`/${collection}/${slug}`}
        />
        <div className="mx-auto max-w-2xl text-center">
          <h1 className="text-3xl font-bold">We couldn't find that page</h1>
          <p className="mt-3 text-neutral-400">
            It may have moved. Browse the{" "}
            <Link to={meta.path} className="text-violet-400 underline">
              {meta.label.toLowerCase()}
            </Link>{" "}
            instead.
          </p>
        </div>
      </MarketingShell>
    );
  }

  const fm = doc.frontmatter;
  const isGlossary = collection === "glossary";
  const trail = [
    { name: "Home", path: "/" },
    { name: meta.label, path: meta.path },
    { name: fm.h1 || fm.title, path: doc.path },
  ];
  const related = resolveRelated(fm.related);

  const jsonLd: object[] = [breadcrumbLd(trail)];
  if (!isGlossary) jsonLd.push(articleLd(doc));
  if (fm.faq?.length) jsonLd.push(faqLd(fm.faq));

  return (
    <MarketingShell>
      <Seo
        title={fm.title}
        description={fm.description}
        path={doc.path}
        type={isGlossary ? "website" : "article"}
        publishedTime={fm.date}
        modifiedTime={fm.updated || fm.date}
        jsonLd={jsonLd}
      />

      <article className="mx-auto max-w-3xl">
        <Breadcrumbs trail={trail} />

        {fm.eyebrow && (
          <div className="mb-3 text-xs font-semibold uppercase tracking-widest text-violet-300">
            {fm.eyebrow}
          </div>
        )}

        <h1 className="text-[clamp(2rem,5vw,3rem)] font-bold leading-tight tracking-tight text-white">
          {fm.h1 || fm.title}
        </h1>

        {fm.updated && !isGlossary && (
          <p className="mt-4 text-xs text-neutral-500">
            Updated{" "}
            {new Date(fm.updated).toLocaleDateString("en-GB", {
              year: "numeric",
              month: "long",
              day: "numeric",
            })}
          </p>
        )}

        <div
          className="article-content mt-8"
          dangerouslySetInnerHTML={{ __html: doc.html }}
        />

        {fm.faq?.length ? (
          <section className="mt-14">
            <h2 className="text-2xl font-bold tracking-tight text-white">
              Frequently asked questions
            </h2>
            <div className="mt-5 divide-y divide-neutral-900 border-y border-neutral-900">
              {fm.faq.map((f) => (
                <details key={f.q} className="group py-4">
                  <summary className="cursor-pointer list-none text-base font-medium text-neutral-100 marker:hidden">
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

        {related.length > 0 && (
          <section className="mt-14">
            <h2 className="text-lg font-semibold text-white">Related reading</h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {related.map((r) => (
                <li key={r.path}>
                  <Link
                    to={r.path}
                    className="block rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 transition hover:border-neutral-600"
                  >
                    <div className="text-sm font-medium text-neutral-100">
                      {r.frontmatter.h1 || r.frontmatter.title}
                    </div>
                    <div className="mt-1 text-xs text-neutral-500">
                      {r.frontmatter.excerpt || r.frontmatter.description}
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        <CtaBlock />
      </article>
    </MarketingShell>
  );
}
