import { Link } from "react-router-dom";
import Seo from "../components/Seo";
import MarketingShell from "../components/marketing/MarketingShell";
import CtaBlock from "../components/marketing/CtaBlock";
import { listDocs } from "../content/registry";
import { TOOLS } from "../content/tools";
import { breadcrumbLd } from "../content/schema";

/**
 * The content hub. Single discoverable entry point (linked from nav + footer)
 * for everything indexable: guides, articles, free tools, glossary and
 * comparisons. Keeps the marketing homepage clean while giving crawlers a
 * dense internal-link surface.
 */
export default function Resources() {
  const guides = listDocs("guides").slice(0, 6);
  const posts = listDocs("blog").slice(0, 6);
  const compare = listDocs("compare").slice(0, 4);
  const glossaryCount = listDocs("glossary").length;

  return (
    <MarketingShell>
      <Seo
        title="Resources — Gang Sheet, DTF & UV DTF Guides + Free Tools | Printlay"
        description="Guides, how-tos and free calculators for print shops: gang sheets, DTF and UV DTF printing, sticker cut lines, imposition and print-ready file prep."
        path="/resources"
        jsonLd={breadcrumbLd([
          { name: "Home", path: "/" },
          { name: "Resources", path: "/resources" },
        ])}
      />

      <div className="mx-auto max-w-5xl">
        <header className="max-w-2xl">
          <h1 className="text-[clamp(2.25rem,5vw,3.25rem)] font-bold tracking-tight text-white">
            Print shop resources
          </h1>
          <p className="mt-4 text-lg text-neutral-400">
            Everything we know about ganging up sheets, DTF and UV DTF transfers,
            sticker cut lines and getting clean print-ready files out the door —
            plus free tools you can use right now.
          </p>
        </header>

        {/* Free tools — lead with the most linkable assets */}
        <Section title="Free tools" href="/tools" linkLabel="All tools">
          <div className="grid gap-4 sm:grid-cols-2">
            {TOOLS.map((t) => (
              <Card
                key={t.slug}
                to={`/tools/${t.slug}`}
                eyebrow="Free tool"
                title={t.h1}
                body={t.blurb}
              />
            ))}
          </div>
        </Section>

        <Section title="Guides" href="/guides" linkLabel="All guides">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {guides.map((d) => (
              <Card
                key={d.path}
                to={d.path}
                eyebrow={d.frontmatter.category || "Guide"}
                title={d.frontmatter.h1 || d.frontmatter.title}
                body={d.frontmatter.excerpt || d.frontmatter.description}
              />
            ))}
          </div>
        </Section>

        <Section title="Latest articles" href="/blog" linkLabel="All articles">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {posts.map((d) => (
              <Card
                key={d.path}
                to={d.path}
                eyebrow={d.frontmatter.category || "Article"}
                title={d.frontmatter.h1 || d.frontmatter.title}
                body={d.frontmatter.excerpt || d.frontmatter.description}
              />
            ))}
          </div>
        </Section>

        {compare.length > 0 && (
          <Section title="Comparisons" href="/compare" linkLabel="All comparisons">
            <div className="grid gap-4 sm:grid-cols-2">
              {compare.map((d) => (
                <Card
                  key={d.path}
                  to={d.path}
                  eyebrow="Comparison"
                  title={d.frontmatter.h1 || d.frontmatter.title}
                  body={d.frontmatter.excerpt || d.frontmatter.description}
                />
              ))}
            </div>
          </Section>
        )}

        <Section title="Glossary" href="/glossary" linkLabel="Browse all">
          <Link
            to="/glossary"
            className="block rounded-2xl border border-neutral-800 bg-neutral-900/40 p-6 transition hover:border-neutral-600"
          >
            <p className="text-neutral-300">
              {glossaryCount} plain-English definitions of printing terms — from{" "}
              <span className="text-neutral-100">gang sheet</span> and{" "}
              <span className="text-neutral-100">UV DTF</span> to{" "}
              <span className="text-neutral-100">kiss cut</span> and{" "}
              <span className="text-neutral-100">bleed</span>.
            </p>
            <span className="mt-3 inline-block text-sm font-medium text-violet-400">
              Open the glossary →
            </span>
          </Link>
        </Section>

        <CtaBlock />
      </div>
    </MarketingShell>
  );
}

function Section({
  title,
  href,
  linkLabel,
  children,
}: {
  title: string;
  href: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-14">
      <div className="mb-5 flex items-baseline justify-between">
        <h2 className="text-xl font-semibold text-white">{title}</h2>
        <Link to={href} className="text-sm font-medium text-violet-400 hover:text-violet-300">
          {linkLabel} →
        </Link>
      </div>
      {children}
    </section>
  );
}

function Card({
  to,
  eyebrow,
  title,
  body,
}: {
  to: string;
  eyebrow: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="flex flex-col rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 transition hover:border-neutral-600"
    >
      <div className="text-[11px] font-semibold uppercase tracking-widest text-violet-300">
        {eyebrow}
      </div>
      <div className="mt-2 font-semibold text-neutral-100">{title}</div>
      <div className="mt-1.5 flex-1 text-sm text-neutral-500">{body}</div>
    </Link>
  );
}
