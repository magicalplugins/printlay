import { NavLink } from "react-router-dom";

const TABS = [
  { to: "/app/widget", label: "Overview", end: true },
  { to: "/app/widget/products", label: "Products" },
  { to: "/app/widget/pricing", label: "Pricing" },
  { to: "/app/widget/orders", label: "Orders" },
  { to: "/app/widget/keys", label: "API keys" },
  { to: "/app/widget/settings", label: "Settings" },
  { to: "/app/widget/preview", label: "Live preview" },
];

export default function WidgetShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <header className="flex items-end justify-between gap-4 flex-wrap mb-6">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{title}</h1>
          {subtitle && <p className="text-neutral-400 text-sm mt-1">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-wrap">{actions}</div>}
      </header>

      <nav className="flex items-center gap-1 flex-wrap border-b border-neutral-800 mb-8">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `px-3 py-2 text-sm font-medium -mb-px border-b-2 transition ${
                isActive
                  ? "border-violet-500 text-white"
                  : "border-transparent text-neutral-400 hover:text-neutral-200"
              }`
            }
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      {children}
    </div>
  );
}

export const card = "rounded-2xl border border-neutral-800 bg-neutral-900/40 p-5 sm:p-6";
export const btnPrimary =
  "rounded-lg bg-white text-neutral-950 px-4 py-2 text-sm font-semibold hover:bg-neutral-200 disabled:opacity-40 transition";
export const btnSecondary =
  "rounded-lg border border-neutral-700 px-4 py-2 text-sm text-neutral-300 hover:border-neutral-500 transition";
export const btnDanger =
  "rounded-lg border border-rose-500/40 text-rose-300 px-3 py-2 text-sm hover:bg-rose-500/10 transition";
export const labelCls = "block text-xs uppercase tracking-wider text-neutral-500 mb-1.5";
export const inputCls =
  "w-full rounded-lg border border-neutral-700 bg-neutral-950/60 px-3 py-2 text-sm text-neutral-100 focus:border-violet-500 focus:outline-none";
export const emptyCls =
  "rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500 text-sm";
