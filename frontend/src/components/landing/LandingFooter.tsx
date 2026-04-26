import { Link } from "react-router-dom";

export default function LandingFooter() {
  return (
    <footer className="px-6 py-12 border-t border-neutral-900">
      <div className="max-w-6xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-xs text-neutral-500">
          © {new Date().getFullYear()} Printlay · Built for print shops who gang up sheets
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-neutral-500">
          <Link to="/pricing" className="hover:text-white transition">
            Pricing
          </Link>
          <Link to="/terms" className="hover:text-white transition">
            Terms
          </Link>
          <Link to="/login" className="hover:text-white transition">
            Sign in
          </Link>
          <Link to="/register" className="hover:text-white transition">
            Start free
          </Link>
        </nav>
      </div>
    </footer>
  );
}
