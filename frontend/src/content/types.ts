/**
 * Shared types for the marketing content engine.
 *
 * Content lives as Markdown files with YAML frontmatter under
 * `src/content/docs/<collection>/<slug>.md`. The registry (registry.ts)
 * loads them at build time via Vite's import.meta.glob, so every page ships
 * as static HTML for crawlers (see scripts/prerender.mjs).
 */

export type Collection =
  | "guides"
  | "blog"
  | "glossary"
  | "compare"
  | "features";

export type FaqItem = { q: string; a: string };

/** Raw frontmatter as authored (all optional except title/description). */
export type DocFrontmatter = {
  /** SEO <title>. Keep ~50-60 chars. */
  title: string;
  /** Meta description. Keep ~150-160 chars. */
  description: string;
  /** On-page <h1>. Falls back to title when omitted. */
  h1?: string;
  /** Short summary used on hub/index cards. Falls back to description. */
  excerpt?: string;
  /** ISO date first published. */
  date?: string;
  /** ISO date last updated. */
  updated?: string;
  /** Primary target keywords (informational only — not a meta keywords tag). */
  keywords?: string[];
  /** Card eyebrow / grouping label. */
  category?: string;
  /** FAQ block — rendered on-page and emitted as FAQPage JSON-LD. */
  faq?: FaqItem[];
  /** Slugs of related docs (any collection) for cross-linking. */
  related?: string[];
  /** Hide from indexes + sitemap while drafting. */
  draft?: boolean;
  /** Feature pages: optional eyebrow shown above the H1. */
  eyebrow?: string;
};

/** A fully-resolved document ready to render. */
export type Doc = {
  collection: Collection;
  slug: string;
  /** Full canonical path, e.g. "/guides/what-is-a-gang-sheet". */
  path: string;
  frontmatter: DocFrontmatter;
  /** Raw markdown body (frontmatter stripped). */
  body: string;
  /** Rendered HTML of the body. */
  html: string;
};
