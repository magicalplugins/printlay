import type { Collection } from "./types";

/** Display metadata for each collection — drives index pages + breadcrumbs. */
export const COLLECTION_META: Record<
  Collection,
  { label: string; path: string; title: string; description: string; blurb: string }
> = {
  guides: {
    label: "Guides",
    path: "/guides",
    title: "Print Production Guides — Gang Sheets, DTF, UV DTF & Stickers",
    description:
      "In-depth guides for print shops: gang sheets, DTF and UV DTF printing, sticker cut lines, imposition and print-ready file prep. Practical, no fluff.",
    blurb:
      "Deep-dive pillar guides on the techniques that move sheets through your shop.",
  },
  blog: {
    label: "Articles",
    path: "/blog",
    title: "Printlay Blog — How-tos & Tips for Print Shops",
    description:
      "How-to articles and practical tips on gang sheets, DTF and UV DTF printing, stickers, cut lines and reducing film waste.",
    blurb: "Short, practical how-tos and tips you can use on today's jobs.",
  },
  glossary: {
    label: "Glossary",
    path: "/glossary",
    title: "Printing Glossary — DTF, UV DTF, Gang Sheet & Cut-Line Terms",
    description:
      "Plain-English definitions of printing terms: gang sheet, DTF, UV DTF, AB film, bleed, cut line, kiss cut, die cut, imposition, DPI and more.",
    blurb: "Plain-English definitions of the terms you meet on the shop floor.",
  },
  compare: {
    label: "Comparisons",
    path: "/compare",
    title: "Gang Sheet & Print Software Comparisons | Printlay",
    description:
      "Honest comparisons of gang sheet builders and print imposition software to help you choose the right tool for your shop.",
    blurb: "Honest, side-by-side comparisons to help you choose.",
  },
  features: {
    label: "Features",
    path: "/resources",
    title: "Printlay Features",
    description: "What Printlay does for print shops.",
    blurb: "What Printlay does for your shop.",
  },
};
