import type { ReactNode } from "react";
import LandingNav from "../landing/LandingNav";
import LandingFooter from "../landing/LandingFooter";

/**
 * Page chrome for the public content surface (resources, guides, blog,
 * glossary, compare, features, tools). Reuses the same nav + footer as the
 * landing page so the marketing site feels like one product, and keeps the
 * dark theme. The hero/landing design is untouched — this is a separate shell.
 */
export default function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-full bg-neutral-950 text-neutral-100">
      <LandingNav />
      <main className="px-6 pt-28 pb-20">{children}</main>
      <LandingFooter />
    </div>
  );
}
