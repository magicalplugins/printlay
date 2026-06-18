/**
 * Server-side render entry used ONLY by the build-time prerender step
 * (scripts/prerender.mjs). It renders the public marketing pages to static
 * HTML so crawlers and link-preview scrapers get real content instead of an
 * empty SPA shell. The in-app (authenticated) routes are never prerendered.
 *
 * Pages are imported eagerly here (unlike App.tsx, which lazy-loads them) so
 * renderToString produces real markup. Because this module is only bundled
 * into dist-ssr (build-time), those eager imports — including the whole
 * content registry — never reach the client app bundle.
 *
 * Everything here must be SSR-safe: AuthProvider / MeProvider only touch the
 * browser inside effects (which don't run during renderToString), so the
 * pages render their logged-out marketing view — exactly what a crawler sees.
 */
import { renderToString } from "react-dom/server";
import { HelmetProvider, type HelmetServerState } from "react-helmet-async";
import { Route, Routes } from "react-router-dom";
import { StaticRouter } from "react-router-dom/server";

import { AuthProvider } from "./auth/AuthProvider";
import { MeProvider } from "./auth/MeProvider";
import Landing from "./pages/Landing";
import Pricing from "./pages/Pricing";
import Terms from "./pages/Terms";
import Resources from "./pages/Resources";
import CollectionIndex from "./pages/CollectionIndex";
import DocPage from "./pages/DocPage";
import ToolsIndex from "./pages/tools/ToolsIndex";
import GangSheetCalculator from "./pages/tools/GangSheetCalculator";
import BleedDpiCalculator from "./pages/tools/BleedDpiCalculator";
import { allDocPaths, allDocs } from "./content/registry";
import { toolPaths } from "./content/tools";
import type { Collection } from "./content/types";
import "./index.css";

/** Marketing routes mirrored from App.tsx (kept in sync intentionally). */
function MarketingRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/pricing" element={<Pricing />} />
      <Route path="/terms" element={<Terms />} />
      <Route path="/resources" element={<Resources />} />
      <Route path="/guides" element={<CollectionIndex collection="guides" />} />
      <Route path="/guides/:slug" element={<DocPage collection="guides" />} />
      <Route path="/blog" element={<CollectionIndex collection="blog" />} />
      <Route path="/blog/:slug" element={<DocPage collection="blog" />} />
      <Route path="/glossary" element={<CollectionIndex collection="glossary" />} />
      <Route path="/glossary/:slug" element={<DocPage collection="glossary" />} />
      <Route path="/compare" element={<CollectionIndex collection="compare" />} />
      <Route path="/compare/:slug" element={<DocPage collection="compare" />} />
      <Route path="/features/:slug" element={<DocPage collection="features" />} />
      <Route path="/tools" element={<ToolsIndex />} />
      <Route path="/tools/gang-sheet-calculator" element={<GangSheetCalculator />} />
      <Route path="/tools/bleed-dpi-calculator" element={<BleedDpiCalculator />} />
    </Routes>
  );
}

const STATIC_ROUTES = [
  "/",
  "/pricing",
  "/terms",
  "/resources",
  "/guides",
  "/blog",
  "/glossary",
  "/compare",
  "/tools",
];

/** Every route to prerender + include in the sitemap. */
export const routes: string[] = [
  ...STATIC_ROUTES,
  ...toolPaths(),
  ...allDocPaths(),
];

export type SitemapEntry = {
  path: string;
  lastmod: string;
  changefreq: string;
  priority: number;
};

const TODAY = new Date().toISOString().slice(0, 10);

const STATIC_META: Record<string, { changefreq: string; priority: number }> = {
  "/": { changefreq: "weekly", priority: 1.0 },
  "/pricing": { changefreq: "weekly", priority: 0.9 },
  "/resources": { changefreq: "weekly", priority: 0.7 },
  "/guides": { changefreq: "weekly", priority: 0.7 },
  "/blog": { changefreq: "weekly", priority: 0.7 },
  "/tools": { changefreq: "weekly", priority: 0.7 },
  "/glossary": { changefreq: "monthly", priority: 0.6 },
  "/compare": { changefreq: "monthly", priority: 0.6 },
  "/terms": { changefreq: "monthly", priority: 0.3 },
};

const COLLECTION_PRIORITY: Record<Collection, number> = {
  guides: 0.8,
  features: 0.8,
  blog: 0.7,
  compare: 0.7,
  glossary: 0.5,
};

/** Structured sitemap entries (path + lastmod + changefreq + priority). */
export function sitemap(): SitemapEntry[] {
  const entries: SitemapEntry[] = [];
  for (const path of STATIC_ROUTES) {
    const m = STATIC_META[path] ?? { changefreq: "weekly", priority: 0.6 };
    entries.push({ path, lastmod: TODAY, ...m });
  }
  for (const path of toolPaths()) {
    entries.push({ path, lastmod: TODAY, changefreq: "monthly", priority: 0.8 });
  }
  for (const doc of allDocs()) {
    entries.push({
      path: doc.path,
      lastmod: doc.frontmatter.updated || doc.frontmatter.date || TODAY,
      changefreq: "monthly",
      priority: COLLECTION_PRIORITY[doc.collection] ?? 0.6,
    });
  }
  return entries;
}

export function render(url: string): { html: string; head: string } {
  const helmetContext: { helmet?: HelmetServerState } = {};
  const html = renderToString(
    <HelmetProvider context={helmetContext}>
      <StaticRouter location={url}>
        <AuthProvider>
          <MeProvider>
            <MarketingRoutes />
          </MeProvider>
        </AuthProvider>
      </StaticRouter>
    </HelmetProvider>
  );
  const h = helmetContext.helmet;
  const head = h
    ? [
        h.title.toString(),
        h.meta.toString(),
        h.link.toString(),
        h.script.toString(),
      ]
        .filter(Boolean)
        .join("\n    ")
    : "";
  return { html, head };
}
