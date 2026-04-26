import { useEffect, useState, useMemo } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";
import { useMe } from "../auth/MeProvider";
import TrialBanner from "./app/TrialBanner";

const NAV = [
  { to: "/app", label: "Dashboard", end: true },
  { to: "/app/templates", label: "Templates" },
  { to: "/app/jobs", label: "Jobs" },
  { to: "/app/catalogue", label: "Catalogue" },
  { to: "/app/outputs", label: "Outputs" },
  { to: "/app/settings", label: "Settings" },
];

export default function Layout() {
  const { session, signOut } = useAuth();
  const { me } = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Auto-close on route change so navigating from inside the drawer
  // doesn't leave the overlay sitting on top of the destination page.
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  // Lock body scroll while the overlay is open (prevents the page
  // underneath from scrolling on iOS rubber-band) and close on Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [drawerOpen]);

  const onSignOut = async () => {
    await signOut();
    navigate("/", { replace: true });
  };

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-neutral-900 bg-neutral-950/80 backdrop-blur sticky top-0 z-30">
        <div className="max-w-7xl mx-auto flex items-center gap-4 sm:gap-8 px-3 sm:px-6 h-14">
          <Link to="/app" className="font-bold tracking-tight text-base sm:text-lg">
            Printlay
          </Link>

          {/* Desktop / tablet: full horizontal nav. */}
          <nav className="hidden md:flex items-center gap-1 text-sm">
            {NAV.map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 transition ${
                    isActive
                      ? "bg-neutral-800 text-white"
                      : "text-neutral-400 hover:text-white"
                  }`
                }
              >
                {n.label}
              </NavLink>
            ))}
            {me?.is_admin && (
              <NavLink
                to="/app/admin"
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 transition border ${
                    isActive
                      ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                      : "border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                  }`
                }
                title="Admin only - visible because your email is in ADMIN_EMAILS"
              >
                Admin
              </NavLink>
            )}
          </nav>

          {/* Right cluster: email + sign-out on desktop, hamburger on mobile. */}
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-neutral-500 hidden lg:inline truncate max-w-[200px]">
              {session?.user.email}
            </span>
            <button
              onClick={onSignOut}
              className="hidden md:inline-flex rounded-md border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:border-neutral-600 hover:text-white"
            >
              Sign out
            </button>

            {/* Mobile menu trigger. Animates between bars and X for a tiny
                bit of physicality - costs nothing, reads as "modern". */}
            <button
              onClick={() => setDrawerOpen((v) => !v)}
              className="md:hidden inline-flex items-center justify-center w-10 h-10 rounded-lg border border-neutral-800 text-neutral-300 hover:border-neutral-600 hover:text-white active:bg-neutral-900"
              aria-label={drawerOpen ? "Close menu" : "Open menu"}
              aria-expanded={drawerOpen}
              aria-controls="mobile-menu"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 20 20"
                aria-hidden
                className="transition-transform duration-200"
              >
                {drawerOpen ? (
                  <path
                    d="M5 5l10 10M15 5L5 15"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                ) : (
                  <>
                    <path d="M3 6h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M3 10h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    <path d="M3 14h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>
      </header>

      <MobileMenu
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSignOut={onSignOut}
        email={session?.user.email ?? null}
        isAdmin={me?.is_admin ?? false}
      />

      <TrialBanner />
      <LockedBar />

      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}

/**
 * Persistent bar shown when a user's trial has expired and they have no
 * active subscription. Appears on every page so they can't miss the
 * reactivation path, but is subtle enough not to panic them — their data
 * is safe and the app is still navigable.
 */
function LockedBar() {
  const { me } = useMe();

  const isLocked = useMemo(() => {
    if (!me) return false;
    // Admins always have full enterprise access — no plan required.
    if (me.is_admin) return false;
    if (me.stripe_subscription_status === "active") return false;
    if (me.tier === "enterprise") return false;
    if (me.trial_ends_at) {
      return new Date(me.trial_ends_at).getTime() <= Date.now();
    }
    return false;
  }, [me]);

  if (!isLocked) return null;

  return (
    <div className="w-full bg-neutral-900 border-b border-neutral-800 px-3 py-2 flex items-center justify-center gap-3 flex-wrap text-sm">
      <span className="text-neutral-400">
        Your trial has ended. Your templates and artwork are still here —
      </span>
      <Link
        to="/pricing"
        className="font-semibold text-violet-300 hover:text-violet-200 transition"
      >
        Pick a plan to continue →
      </Link>
    </div>
  );
}

/**
 * Full-screen mobile menu. Slides in from the right with a fade-in
 * backdrop. Each nav row is large (52px tap target) and groups admin /
 * sign-out under their own labelled sections so the menu doesn't feel
 * like one undifferentiated list.
 */
function MobileMenu({
  open,
  onClose,
  onSignOut,
  email,
  isAdmin,
}: {
  open: boolean;
  onClose: () => void;
  onSignOut: () => void;
  email: string | null;
  isAdmin: boolean;
}) {
  return (
    <>
      {/* Backdrop. Pointer-events disabled when closed so it doesn't
          intercept clicks under the (transparent) nav. */}
      <div
        onClick={onClose}
        className={`md:hidden fixed inset-0 z-20 bg-black/70 backdrop-blur-sm transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden="true"
      />

      {/* Drawer panel. Full-screen on phones, capped to 360px so on
          larger phones / iPads (portrait) the page underneath stays
          visible at the edge - it reads as a sheet, not a tab change. */}
      <aside
        id="mobile-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Main menu"
        className={`md:hidden fixed top-14 right-0 bottom-0 z-30 w-full sm:max-w-sm bg-neutral-950 border-l border-neutral-900 shadow-2xl flex flex-col transition-transform duration-200 ease-out ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={onClose}
              className={({ isActive }) =>
                `flex items-center justify-between rounded-xl px-4 py-3.5 text-base transition ${
                  isActive
                    ? "bg-neutral-900 text-white border border-neutral-800"
                    : "text-neutral-300 hover:bg-neutral-900 hover:text-white"
                }`
              }
            >
              <span>{n.label}</span>
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden
                className="text-neutral-600"
              >
                <path
                  d="M5 3l4 4-4 4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </NavLink>
          ))}

          {isAdmin && (
            <>
              <div className="pt-4 pb-1 px-4 text-[10px] uppercase tracking-widest text-neutral-500">
                Admin
              </div>
              <NavLink
                to="/app/admin"
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center justify-between rounded-xl px-4 py-3 text-base transition border ${
                    isActive
                      ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                      : "border-violet-500/30 text-violet-300 hover:bg-violet-500/10"
                  }`
                }
              >
                <span>Admin dashboard</span>
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                  <path
                    d="M5 3l4 4-4 4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </NavLink>
            </>
          )}
        </nav>

        <div className="border-t border-neutral-900 px-4 py-4 space-y-2">
          {email && (
            <div className="text-[11px] uppercase tracking-widest text-neutral-500">
              Signed in
              <div className="mt-0.5 text-sm text-neutral-300 font-normal normal-case truncate">
                {email}
              </div>
            </div>
          )}
          <button
            onClick={() => {
              onClose();
              onSignOut();
            }}
            className="w-full h-11 rounded-xl border border-neutral-800 text-sm font-medium text-neutral-300 hover:border-rose-500/50 hover:text-rose-300 active:bg-neutral-900"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
