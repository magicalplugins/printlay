import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { useAuth } from "../../auth/AuthProvider";

/**
 * Top navigation for the public marketing surface (Landing + Pricing).
 *
 * Transparent at the top of the page so the hero gradient bleeds through;
 * fades to a solid backdrop with a hairline border once the user has
 * scrolled even a few pixels — that's the established "premium SaaS" cue.
 *
 * Behaviour:
 *   - Logged out  → Pricing | Sign in | Start free (CTA, white)
 *   - Logged in   → Pricing | Go to app (CTA)
 */
export default function LandingNav() {
  const { session } = useAuth();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 inset-x-0 z-40 transition-colors duration-300 ${
        scrolled
          ? "bg-neutral-950/85 backdrop-blur-md border-b border-neutral-900"
          : "bg-transparent"
      }`}
    >
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-3">
        <Link
          to="/"
          className="font-bold tracking-tight text-base sm:text-lg text-white"
        >
          Printlay
        </Link>

        <nav className="flex items-center gap-1 sm:gap-2">
          <Link
            to="/pricing"
            className="rounded-lg px-3 sm:px-4 h-9 inline-flex items-center text-sm text-neutral-300 hover:text-white transition"
          >
            Pricing
          </Link>

          {session ? (
            <Link
              to="/app"
              className="rounded-lg bg-white px-4 h-9 inline-flex items-center text-sm font-semibold text-neutral-950 hover:bg-neutral-200 transition"
            >
              Go to app →
            </Link>
          ) : (
            <>
              <Link
                to="/login"
                className="hidden sm:inline-flex rounded-lg px-3 h-9 items-center text-sm text-neutral-300 hover:text-white transition"
              >
                Sign in
              </Link>
              <Link
                to="/register"
                className="rounded-lg bg-white px-4 h-9 inline-flex items-center text-sm font-semibold text-neutral-950 hover:bg-neutral-200 transition"
              >
                Start free
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
