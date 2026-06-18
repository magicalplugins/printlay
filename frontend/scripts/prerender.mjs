/**
 * Build-time prerender for the public marketing pages.
 *
 * Pipeline (see package.json "build"):
 *   1. vite build            -> dist/ (client bundle + dist/index.html template)
 *   2. vite build --ssr ...  -> dist-ssr/entry-ssr.js (Node-renderable pages)
 *   3. node scripts/prerender.mjs (this file)
 *
 * For each public route we render the page to an HTML string, strip the
 * template's default SEO tags, inject the route-specific <title>/meta/canonical
 * (collected from react-helmet-async) plus the rendered body into #root, and
 * write the result. The homepage overwrites dist/index.html; other routes get
 * dist/<route>/index.html (served by the FastAPI _serve_spa directory lookup).
 *
 * Crawlers and JS-blind scrapers read this static HTML. When the SPA boots,
 * createRoot replaces #root with the live React tree, so users are unaffected.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const distDir = join(root, "dist");
const ssrEntry = join(root, "dist-ssr", "entry-ssr.js");

const { render, routes, sitemap } = await import(ssrEntry);

const template = readFileSync(join(distDir, "index.html"), "utf-8");

const SITE = "https://printlay.co.uk";

/** Remove the template's default SEO tags so per-route tags don't duplicate. */
function stripDefaultHead(html) {
  return html
    .replace(/\s*<title>[\s\S]*?<\/title>/i, "")
    .replace(/\s*<meta\s+name="description"[^>]*>/gi, "")
    .replace(/\s*<meta\s+property="og:[^"]*"[^>]*>/gi, "")
    .replace(/\s*<meta\s+name="twitter:[^"]*"[^>]*>/gi, "")
    .replace(/\s*<link\s+rel="canonical"[^>]*>/gi, "");
}

function outPathFor(route) {
  if (route === "/") return join(distDir, "index.html");
  return join(distDir, route.replace(/^\//, ""), "index.html");
}

let count = 0;
for (const route of routes) {
  const { html, head } = render(route);
  let page = stripDefaultHead(template);
  // Inject the route-specific head just before </head>.
  page = page.replace("</head>", `    ${head}\n  </head>`);
  // Seed #root with the prerendered markup.
  page = page.replace(
    '<div id="root"></div>',
    `<div id="root">${html}</div>`
  );
  const out = outPathFor(route);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, page, "utf-8");
  count += 1;
  console.log(`prerendered ${route} -> ${out.replace(root + "/", "")}`);
}

console.log(`Prerender complete: ${count} route(s).`);

// Generate sitemap.xml from the same route set (overwrites the static copy
// from public/). robots.txt points crawlers here.
const entries = sitemap();
const urls = entries
  .map(
    (e) =>
      `  <url>\n    <loc>${SITE}${e.path}</loc>\n    <lastmod>${e.lastmod}</lastmod>\n    <changefreq>${e.changefreq}</changefreq>\n    <priority>${e.priority.toFixed(1)}</priority>\n  </url>`
  )
  .join("\n");
const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
writeFileSync(join(distDir, "sitemap.xml"), sitemapXml, "utf-8");
console.log(`sitemap.xml written: ${entries.length} URL(s).`);
