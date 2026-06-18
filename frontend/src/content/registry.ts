/**
 * Content registry.
 *
 * Loads every Markdown doc under ./docs/<collection>/<slug>.md at build time
 * (Vite import.meta.glob, eager + raw), parses frontmatter, renders the body
 * to HTML, and exposes lookup/listing helpers used by the page components,
 * the SSR prerender, and the sitemap generator.
 *
 * Because the glob is eager, this module pulls in all content. It is imported
 * only by the public marketing pages (lazy-loaded chunks on the client) and by
 * the SSR entry (build-time only) — never by the authenticated app bundle.
 */
import type { Collection, Doc, DocFrontmatter } from "./types";
import { renderMarkdown } from "./markdown";
import { parseFrontmatter } from "./frontmatter";

const COLLECTIONS: Collection[] = [
  "guides",
  "blog",
  "glossary",
  "compare",
  "features",
];

// Keys look like "./docs/guides/what-is-a-gang-sheet.md".
const RAW = import.meta.glob("./docs/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function parsePath(key: string): { collection: Collection; slug: string } | null {
  const m = key.match(/\.\/docs\/([^/]+)\/([^/]+)\.md$/);
  if (!m) return null;
  const collection = m[1] as Collection;
  if (!COLLECTIONS.includes(collection)) return null;
  return { collection, slug: m[2] };
}

function build(): Doc[] {
  const docs: Doc[] = [];
  for (const [key, raw] of Object.entries(RAW)) {
    const parsed = parsePath(key);
    if (!parsed) continue;
    const { collection, slug } = parsed;
    const { data, content } = parseFrontmatter(raw);
    const frontmatter = data as unknown as DocFrontmatter;
    if (!frontmatter.title || !frontmatter.description) {
      // Fail loudly at build time — a doc without SEO basics is a bug.
      throw new Error(`Content ${key} is missing a title or description.`);
    }
    if (frontmatter.draft) continue;
    docs.push({
      collection,
      slug,
      path: `/${collection}/${slug}`,
      frontmatter,
      body: content,
      html: renderMarkdown(content),
    });
  }
  return docs;
}

const ALL: Doc[] = build();

const BY_PATH = new Map<string, Doc>(ALL.map((d) => [d.path, d]));
const BY_SLUG = new Map<string, Doc>(ALL.map((d) => [d.slug, d]));

/** Newest first, by updated || date. */
function byDateDesc(a: Doc, b: Doc): number {
  const da = a.frontmatter.updated || a.frontmatter.date || "";
  const db = b.frontmatter.updated || b.frontmatter.date || "";
  return db.localeCompare(da);
}

export function getDoc(collection: Collection, slug: string): Doc | undefined {
  return BY_PATH.get(`/${collection}/${slug}`);
}

export function getDocBySlug(slug: string): Doc | undefined {
  return BY_SLUG.get(slug);
}

export function listDocs(collection: Collection): Doc[] {
  return ALL.filter((d) => d.collection === collection).sort(byDateDesc);
}

export function allDocs(): Doc[] {
  return [...ALL].sort(byDateDesc);
}

/** Every renderable doc path, for prerender + sitemap enumeration. */
export function allDocPaths(): string[] {
  return ALL.map((d) => d.path);
}

/** Resolve related-doc slugs into full Docs (skips unknown slugs). */
export function resolveRelated(slugs: string[] | undefined): Doc[] {
  if (!slugs) return [];
  return slugs
    .map((s) => BY_SLUG.get(s))
    .filter((d): d is Doc => Boolean(d));
}
