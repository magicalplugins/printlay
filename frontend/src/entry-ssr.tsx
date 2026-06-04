/**
 * Server-side render entry used ONLY by the build-time prerender step
 * (scripts/prerender.mjs). It renders the public marketing pages to static
 * HTML so crawlers and link-preview scrapers get real content instead of an
 * empty SPA shell. The in-app (authenticated) routes are never prerendered.
 *
 * Everything here must be SSR-safe: AuthProvider / MeProvider only touch the
 * browser inside effects (which don't run during renderToString), so the
 * pages render their logged-out marketing view — exactly what a crawler sees.
 */
import type { ComponentType } from "react";
import { renderToString } from "react-dom/server";
import { HelmetProvider, type HelmetServerState } from "react-helmet-async";
import { StaticRouter } from "react-router-dom/server";

import { AuthProvider } from "./auth/AuthProvider";
import { MeProvider } from "./auth/MeProvider";
import Landing from "./pages/Landing";
import Pricing from "./pages/Pricing";
import Terms from "./pages/Terms";
import "./index.css";

const PAGES: Record<string, ComponentType> = {
  "/": Landing,
  "/pricing": Pricing,
  "/terms": Terms,
};

export const routes = Object.keys(PAGES);

export function render(url: string): { html: string; head: string } {
  const Page = PAGES[url] ?? Landing;
  const helmetContext: { helmet?: HelmetServerState } = {};
  const html = renderToString(
    <HelmetProvider context={helmetContext}>
      <StaticRouter location={url}>
        <AuthProvider>
          <MeProvider>
            <Page />
          </MeProvider>
        </AuthProvider>
      </StaticRouter>
    </HelmetProvider>
  );
  const h = helmetContext.helmet;
  const head = h
    ? [h.title.toString(), h.meta.toString(), h.link.toString()]
        .filter(Boolean)
        .join("\n    ")
    : "";
  return { html, head };
}
