import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider } from "./auth/AuthProvider";
import { RequireAuth } from "./auth/RequireAuth";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RouteFallback } from "./components/RouteFallback";
import Layout from "./components/Layout";
import Landing from "./pages/Landing";

// Code-split: the landing/auth pages are eagerly loaded for snappy first
// paint; the in-app pages live in a second chunk so unauthenticated visitors
// never download them.
const Login = lazy(() => import("./pages/Login"));
const Register = lazy(() => import("./pages/Register"));
const Dashboard = lazy(() => import("./pages/Dashboard"));
const Templates = lazy(() => import("./pages/Templates"));
const TemplateWizard = lazy(() => import("./pages/TemplateWizard"));
const TemplateDetail = lazy(() => import("./pages/TemplateDetail"));
const Jobs = lazy(() => import("./pages/Jobs"));
const JobProgrammer = lazy(() => import("./pages/JobProgrammer"));
const JobFiller = lazy(() => import("./pages/JobFiller"));
const Catalogue = lazy(() => import("./pages/Catalogue"));
const Outputs = lazy(() => import("./pages/Outputs"));

export default function App() {
  return (
    <ErrorBoundary>
      <AuthProvider>
        <Suspense fallback={<RouteFallback />}>
          <Routes>
            <Route path="/" element={<Landing />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Register />} />

            <Route
              path="/app"
              element={
                <RequireAuth>
                  <Layout />
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
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </AuthProvider>
    </ErrorBoundary>
  );
}
