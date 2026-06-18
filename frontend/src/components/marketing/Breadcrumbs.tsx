import { Link } from "react-router-dom";

export type Crumb = { name: string; path: string };

/**
 * Visible breadcrumb trail. Pair with breadcrumbLd() in the page's Seo jsonLd
 * so the same trail is exposed to search engines.
 */
export default function Breadcrumbs({ trail }: { trail: Crumb[] }) {
  return (
    <nav aria-label="Breadcrumb" className="mb-6">
      <ol className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={c.path} className="flex items-center gap-1.5">
              {last ? (
                <span className="text-neutral-400">{c.name}</span>
              ) : (
                <Link to={c.path} className="hover:text-neutral-200 transition">
                  {c.name}
                </Link>
              )}
              {!last && <span aria-hidden className="text-neutral-700">/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
