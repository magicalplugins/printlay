/**
 * JSON-LD builders. Kept framework-agnostic (plain objects) so they can be
 * passed straight to <Seo jsonLd={...}> on any page.
 */
import { SITE_URL } from "../components/Seo";
import type { Doc, FaqItem } from "./types";

export function breadcrumbLd(
  trail: { name: string; path: string }[]
): object {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${SITE_URL}${c.path}`,
    })),
  };
}

export function faqLd(faq: FaqItem[]): object {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faq.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };
}

export function articleLd(doc: Doc): object {
  const fm = doc.frontmatter;
  return {
    "@context": "https://schema.org",
    "@type": doc.collection === "blog" ? "BlogPosting" : "Article",
    headline: fm.h1 || fm.title,
    description: fm.description,
    image: `${SITE_URL}/og-image.png`,
    datePublished: fm.date,
    dateModified: fm.updated || fm.date,
    mainEntityOfPage: `${SITE_URL}${doc.path}`,
    author: { "@type": "Organization", name: "Printlay" },
    publisher: {
      "@type": "Organization",
      name: "Printlay",
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}/og-image.png`,
      },
    },
  };
}
