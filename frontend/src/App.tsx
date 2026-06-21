import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { MeProvider } from "./auth/MeProvider";
import { RequireAdmin } from "./auth/RequireAdmin";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireProfile } from "./auth/RequireProfile";
import { RequireWidget } from "./auth/RequireWidget";
import { ErrorBoundary } from "./components/ErrorBoundary";
import LeadChatWidget from "./components/LeadChatWidget";
import { RouteFallback } from "./components/RouteFallback";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";
import { lazyWithRetry } from "./utils/lazyWithRetry";

// Code-split: the landing/auth pages are eagerly loaded for snappy first
// paint; the in-app pages live in a second chunk so unauthenticated visitors
// never download them. lazyWithRetry auto-reloads once if a chunk 404s
// after a redeploy (stale bundle in the browser).
const Login = lazyWithRetry(() => import("./pages/Login"));
const Register = lazyWithRetry(() => import("./pages/Register"));
const Dashboard = lazyWithRetry(() => import("./pages/Dashboard"));
const Templates = lazyWithRetry(() => import("./pages/Templates"));
const TemplateWizard = lazyWithRetry(() => import("./pages/TemplateWizard"));
const StickerEditor = lazyWithRetry(() => import("./pages/StickerEditor"));
const TemplateDetail = lazyWithRetry(() => import("./pages/TemplateDetail"));
const Jobs = lazyWithRetry(() => import("./pages/Jobs"));
const JobProgrammer = lazyWithRetry(() => import("./pages/JobProgrammer"));
const JobFiller = lazyWithRetry(() => import("./pages/JobFiller"));
const Catalogue = lazyWithRetry(() => import("./pages/Catalogue"));
const Outputs = lazyWithRetry(() => import("./pages/Outputs"));
const SheetBuilder = lazyWithRetry(() => import("./pages/SheetBuilder"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const ProfileSetup = lazyWithRetry(() => import("./pages/ProfileSetup"));
const Admin = lazyWithRetry(() => import("./pages/Admin"));
const AdminUsers = lazyWithRetry(() => import("./pages/AdminUsers"));
const AdminLeads = lazyWithRetry(() => import("./pages/AdminLeads"));
const AdminInvites = lazyWithRetry(() => import("./pages/AdminInvites"));
const AdminIntegrations = lazyWithRetry(() => import("./pages/AdminIntegrations"));
const AdminChangelog = lazyWithRetry(() => import("./pages/AdminChangelog"));
const Help = lazyWithRetry(() => import("./pages/Help"));
const Pricing = lazyWithRetry(() => import("./pages/Pricing"));
const Terms = lazyWithRetry(() => import("./pages/Terms"));
const BillingSuccess = lazyWithRetry(() => import("./pages/BillingSuccess"));
const AffiliateSignup = lazyWithRetry(() => import("./pages/AffiliateSignup"));
// Public marketing content surface (SEO). Lazy-loaded so the content registry
// and rendered pages never ship in the authenticated app bundle. The SSR
// prerender (entry-ssr.tsx) imports the same pages eagerly at build time.
const Resources = lazyWithRetry(() => import("./pages/Resources"));
const CollectionIndex = lazyWithRetry(() => import("./pages/CollectionIndex"));
const DocPage = lazyWithRetry(() => import("./pages/DocPage"));
const ToolsIndex = lazyWithRetry(() => import("./pages/tools/ToolsIndex"));
const GangSheetCalculator = lazyWithRetry(
  () => import("./pages/tools/GangSheetCalculator")
);
const BleedDpiCalculator = lazyWithRetry(
  () => import("./pages/tools/BleedDpiCalculator")
);
const FreeSheetTool = lazyWithRetry(
  () => import("./pages/FreeSheetTool")
);
const AffiliateDashboard = lazyWithRetry(() => import("./pages/AffiliateDashboard"));
const AdminAffiliate = lazyWithRetry(() => import("./pages/AdminAffiliate"));
const AdminCatalogues = lazyWithRetry(() => import("./pages/AdminCatalogues"));
// Sticker-widget merchant admin (Studio feature). Its own chunk; guarded by
// RequireWidget so only entitled merchants load it.
const WidgetHub = lazyWithRetry(() => import("./pages/widget/WidgetHub"));
const WidgetProducts = lazyWithRetry(() => import("./pages/widget/WidgetProducts"));
const WidgetPricing = lazyWithRetry(() => import("./pages/widget/WidgetPricing"));
const WidgetKeys = lazyWithRetry(() => import("./pages/widget/WidgetKeys"));
const WidgetSettingsPage = lazyWithRetry(() => import("./pages/widget/WidgetSettingsPage"));
const WidgetOrders = lazyWithRetry(() => import("./pages/widget/WidgetOrders"));
const WidgetPreview = lazyWithRetry(() => import("./pages/widget/WidgetPreview"));
// Standalone embeddable widget — no app shell or auth guard; authenticates with
// a widget session token from the URL. Loaded in an iframe by stores + preview.
const EmbedSticker = lazyWithRetry(() => import("./embed/EmbedSticker"));
const ProofReview = lazyWithRetry(() => import("./pages/ProofReview"));

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <MeProvider>
          <Suspense fallback={<RouteFallback />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              <Route path="/pricing" element={<Pricing />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/affiliate" element={<AffiliateSignup />} />

              {/* Public content surface (SEO). Crawlable; served as static
                  prerendered HTML and hydrated client-side. */}
              <Route path="/resources" element={<Resources />} />
              <Route path="/guides" element={<CollectionIndex collection="guides" />} />
              <Route path="/guides/:slug" element={<DocPage collection="guides" />} />
              <Route path="/blog" element={<CollectionIndex collection="blog" />} />
              <Route path="/blog/:slug" element={<DocPage collection="blog" />} />
              <Route path="/glossary" element={<CollectionIndex collection="glossary" />} />
              <Route path="/glossary/:slug" element={<DocPage collection="glossary" />} />
              <Route path="/compare" element={<CollectionIndex collection="compare" />} />
              <Route path="/compare/:slug" element={<DocPage collection="compare" />} />
              <Route path="/features/:slug" element={<DocPage collection="features" />} />
              <Route path="/tools" element={<ToolsIndex />} />
              <Route
                path="/tools/gang-sheet-calculator"
                element={<GangSheetCalculator />}
              />
              <Route
                path="/tools/bleed-dpi-calculator"
                element={<BleedDpiCalculator />}
              />
              <Route
                path="/tools/gang-sheet"
                element={<FreeSheetTool />}
              />
              {/* Embeddable sticker designer. No auth/profile guard and no app
                  shell — it runs inside an iframe and authenticates purely with
                  the widget session token in its URL. */}
              <Route path="/embed/sticker" element={<EmbedSticker />} />

              {/* Public proof review page — accessed via unique token link */}
              <Route path="/proof/:token" element={<ProofReview />} />

              <Route
                path="/billing/success"
                element={
                  <RequireAuth>
                    <BillingSuccess />
                  </RequireAuth>
                }
              />

              {/* Profile gate sits OUTSIDE the main layout so it doesn't
                  show the nav/sidebar until the user has filled it in. */}
              <Route
                path="/profile-setup"
                element={
                  <RequireAuth>
                    <ProfileSetup />
                  </RequireAuth>
                }
              />

              <Route
                path="/app"
                element={
                  <RequireAuth>
                    <RequireProfile>
                      <Layout />
                    </RequireProfile>
                  </RequireAuth>
                }
              >
                <Route index element={<Dashboard />} />
                <Route path="templates" element={<Templates />} />
                <Route path="templates/new" element={<TemplateWizard />} />
                <Route
                  path="templates/new/sticker"
                  element={
                    <RequireAdmin>
                      <StickerEditor />
                    </RequireAdmin>
                  }
                />
                <Route path="templates/:id" element={<TemplateDetail />} />
                <Route path="jobs" element={<Jobs />} />
                <Route path="jobs/new" element={<JobProgrammer />} />
                <Route path="jobs/:id/program" element={<JobProgrammer />} />
                <Route path="jobs/:id/fill" element={<JobFiller />} />
                <Route path="catalogue" element={<Catalogue />} />
                <Route path="outputs" element={<Outputs />} />
                <Route path="sheets" element={<SheetBuilder />} />
                <Route path="settings" element={<Settings />} />
                <Route path="affiliate" element={<AffiliateDashboard />} />
                <Route path="help" element={<Help />} />
                <Route
                  path="widget"
                  element={
                    <RequireWidget>
                      <WidgetHub />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/products"
                  element={
                    <RequireWidget>
                      <WidgetProducts />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/pricing"
                  element={
                    <RequireWidget>
                      <WidgetPricing />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/orders"
                  element={
                    <RequireWidget>
                      <WidgetOrders />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/keys"
                  element={
                    <RequireWidget>
                      <WidgetKeys />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/settings"
                  element={
                    <RequireWidget>
                      <WidgetSettingsPage />
                    </RequireWidget>
                  }
                />
                <Route
                  path="widget/preview"
                  element={
                    <RequireWidget>
                      <WidgetPreview />
                    </RequireWidget>
                  }
                />
                <Route
                  path="admin"
                  element={
                    <RequireAdmin>
                      <Admin />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/users"
                  element={
                    <RequireAdmin>
                      <AdminUsers />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/leads"
                  element={
                    <RequireAdmin>
                      <AdminLeads />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/invites"
                  element={
                    <RequireAdmin>
                      <AdminInvites />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/integrations"
                  element={
                    <RequireAdmin>
                      <AdminIntegrations />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/changelog"
                  element={
                    <RequireAdmin>
                      <AdminChangelog />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/affiliate"
                  element={
                    <RequireAdmin>
                      <AdminAffiliate />
                    </RequireAdmin>
                  }
                />
                <Route
                  path="admin/catalogues"
                  element={
                    <RequireAdmin>
                      <AdminCatalogues />
                    </RequireAdmin>
                  }
                />
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
          <LeadChatWidget />
        </MeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
