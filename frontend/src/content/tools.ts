/**
 * Metadata for the free public tools (link magnets). The interactive UI lives
 * in src/pages/tools/*; this registry drives routing, the /tools index, the
 * resources hub, and sitemap/prerender enumeration. Keep slugs in sync with
 * the routes declared in App.tsx (client, lazy) and entry-ssr.tsx (SSR).
 */
export type ToolMeta = {
  slug: string;
  /** SEO <title>. */
  title: string;
  /** Meta description. */
  description: string;
  /** On-page <h1>. */
  h1: string;
  /** One-line pitch for index/hub cards. */
  blurb: string;
};

export const TOOLS: ToolMeta[] = [
  {
    slug: "gang-sheet-calculator",
    title: "Free Gang Sheet Calculator — Fit, Cost & Waste | Printlay",
    description:
      "Free gang sheet calculator: enter your sheet and design sizes to see how many prints fit, sheets needed, cost per print and material waste. DTF, UV DTF & stickers.",
    h1: "Gang sheet calculator",
    blurb:
      "Work out how many designs fit a sheet, sheets needed, cost per print and wasted film.",
  },
  {
    slug: "bleed-dpi-calculator",
    title: "Bleed, DPI & mm/Inch Calculator for Printing | Printlay",
    description:
      "Free print prep calculator: convert mm to inches, add bleed to any size, and check whether your image resolution is high enough DPI for sharp printing.",
    h1: "Bleed & DPI calculator",
    blurb:
      "Convert mm/inches, add bleed, and check if an image has enough DPI to print sharp.",
  },
];

export const toolPaths = (): string[] => TOOLS.map((t) => `/tools/${t.slug}`);

export const getTool = (slug: string): ToolMeta | undefined =>
  TOOLS.find((t) => t.slug === slug);
