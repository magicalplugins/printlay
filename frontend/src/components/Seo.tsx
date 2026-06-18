import { Helmet } from "react-helmet-async";

const SITE = "https://printlay.co.uk";
const OG_IMAGE = `${SITE}/og-image.png`;

type SeoProps = {
  title: string;
  description: string;
  /** Path-only canonical, e.g. "/pricing". Defaults to "/". */
  path?: string;
  /** og:type — "website" (default) or "article" for guides/blog posts. */
  type?: "website" | "article";
  /** Article published time (ISO), emitted as article:published_time. */
  publishedTime?: string;
  /** Article modified time (ISO), emitted as article:modified_time. */
  modifiedTime?: string;
  /**
   * JSON-LD structured data. Accepts a single object or an array; each is
   * emitted as its own <script type="application/ld+json">. Picked up live by
   * Googlebot's JS render and baked into static HTML by the prerender step
   * (which now serialises Helmet's <script> tags too — see entry-ssr.tsx).
   */
  jsonLd?: object | object[];
};

/**
 * Per-route document head. Picked up live by Googlebot's JS render and baked
 * into the static HTML at build time by the prerender step (HelmetProvider
 * collects these tags server-side).
 */
export default function Seo({
  title,
  description,
  path = "/",
  type = "website",
  publishedTime,
  modifiedTime,
  jsonLd,
}: SeoProps) {
  const url = `${SITE}${path}`;
  const blocks = jsonLd ? (Array.isArray(jsonLd) ? jsonLd : [jsonLd]) : [];
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />

      <meta property="og:type" content={type} />
      <meta property="og:site_name" content="Printlay" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={OG_IMAGE} />
      {type === "article" && publishedTime && (
        <meta property="article:published_time" content={publishedTime} />
      )}
      {type === "article" && modifiedTime && (
        <meta property="article:modified_time" content={modifiedTime} />
      )}

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={OG_IMAGE} />

      {blocks.map((block, i) => (
        <script key={i} type="application/ld+json">
          {JSON.stringify(block)}
        </script>
      ))}
    </Helmet>
  );
}

/** Canonical site origin, exported for JSON-LD builders. */
export const SITE_URL = SITE;
