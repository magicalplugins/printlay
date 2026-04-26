import { Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { MeProvider } from "./auth/MeProvider";
import { RequireAdmin } from "./auth/RequireAdmin";
import { RequireAuth } from "./auth/RequireAuth";
import { RequireProfile } from "./auth/RequireProfile";
import { ErrorBoundary } from "./components/ErrorBoundary";
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
const TemplateDetail = lazyWithRetry(() => import("./pages/TemplateDetail"));
const Jobs = lazyWithRetry(() => import("./pages/Jobs"));
const JobProgrammer = lazyWithRetry(() => import("./pages/JobProgrammer"));
const JobFiller = lazyWithRetry(() => import("./pages/JobFiller"));
const Catalogue = lazyWithRetry(() => import("./pages/Catalogue"));
const Outputs = lazyWithRetry(() => import("./pages/Outputs"));
const Settings = lazyWithRetry(() => import("./pages/Settings"));
const ProfileSetup = lazyWithRetry(() => import("./pages/ProfileSetup"));
const Admin = lazyWithRetry(() => import("./pages/Admin"));
const AdminUsers = lazyWithRetry(() => import("./pages/AdminUsers"));
const Pricing = lazyWithRetry(() => import("./pages/Pricing"));
const Terms = lazyWithRetry(() => import("./pages/Terms"));
const BillingSuccess = lazyWithRetry(() => import("./pages/BillingSuccess"));

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
                <Route path="templates/:id" element={<TemplateDetail />} />
                <Route path="jobs" element={<Jobs />} />
                <Route path="jobs/new" element={<JobProgrammer />} />
                <Route path="jobs/:id/program" element={<JobProgrammer />} />
                <Route path="jobs/:id/fill" element={<JobFiller />} />
                <Route path="catalogue" element={<Catalogue />} />
                <Route path="outputs" element={<Outputs />} />
                <Route path="settings" element={<Settings />} />
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
              </Route>

              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </Suspense>
        </MeProvider>
      </AuthProvider>
    </ErrorBoundary>
  );
}
