import { Link } from "react-router-dom";

const FOOTER_LINKS: { heading: string; links: { to: string; label: string }[] }[] = [
  {
    heading: "Product",
    links: [
      { to: "/pricing", label: "Pricing" },
      { to: "/register", label: "Start free" },
      { to: "/login", label: "Sign in" },
    ],
  },
  {
    heading: "Resources",
    links: [
      { to: "/resources", label: "Resource hub" },
      { to: "/guides", label: "Guides" },
      { to: "/blog", label: "Articles" },
      { to: "/glossary", label: "Glossary" },
    ],
  },
  {
    heading: "Free tools",
    links: [
      { to: "/tools/gang-sheet-calculator", label: "Gang sheet calculator" },
      { to: "/tools/bleed-dpi-calculator", label: "Bleed & DPI calculator" },
      { to: "/compare", label: "Comparisons" },
    ],
  },
];

export default function LandingFooter() {
  return (
    <footer className="px-6 py-14 border-t border-neutral-900">
      <div className="max-w-6xl mx-auto">
        <div className="grid grid-cols-2 gap-8 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <Link to="/" className="font-bold tracking-tight text-white">
              Printlay
            </Link>
            <p className="mt-3 text-xs leading-relaxed text-neutral-500">
              Print-ready gang sheets, DTF &amp; UV DTF layouts and sticker cut
              lines — in four moves.
            </p>
          </div>
          {FOOTER_LINKS.map((col) => (
            <div key={col.heading}>
              <div className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
                {col.heading}
              </div>
              <ul className="mt-3 space-y-2 text-sm text-neutral-500">
                {col.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to} className="hover:text-white transition">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <div className="mt-10 flex flex-col sm:flex-row items-center justify-between gap-3 border-t border-neutral-900 pt-6">
          <p className="text-xs text-neutral-500">
            © {new Date().getFullYear()} Printlay · Built for print shops who gang up sheets
          </p>
          <Link to="/terms" className="text-xs text-neutral-500 hover:text-white transition">
            Terms
          </Link>
        </div>
      </div>
    </footer>
  );
}
