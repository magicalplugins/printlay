import { Helmet } from "react-helmet-async";

const SITE = "https://printlay.co.uk";
const OG_IMAGE = `${SITE}/og-image.png`;

type SeoProps = {
  title: string;
  description: string;
  /** Path-only canonical, e.g. "/pricing". Defaults to "/". */
  path?: string;
};

/**
 * Per-route document head. Picked up live by Googlebot's JS render and baked
 * into the static HTML at build time by the prerender step (HelmetProvider
 * collects these tags server-side).
 */
export default function Seo({ title, description, path = "/" }: SeoProps) {
  const url = `${SITE}${path}`;
  return (
    <Helmet>
      <title>{title}</title>
      <meta name="description" content={description} />
      <link rel="canonical" href={url} />

      <meta property="og:type" content="website" />
      <meta property="og:site_name" content="Printlay" />
      <meta property="og:title" content={title} />
      <meta property="og:description" content={description} />
      <meta property="og:url" content={url} />
      <meta property="og:image" content={OG_IMAGE} />

      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={title} />
      <meta name="twitter:description" content={description} />
      <meta name="twitter:image" content={OG_IMAGE} />
    </Helmet>
  );
}
