import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthProvider";

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
  const navigate = useNavigate();

  return (
    <div className="min-h-full flex flex-col">
      <header className="border-b border-neutral-900 bg-neutral-950/80 backdrop-blur sticky top-0 z-10">
        <div className="max-w-7xl mx-auto flex items-center gap-8 px-6 h-14">
          <Link to="/app" className="font-bold tracking-tight">
            Printlay
          </Link>
          <nav className="flex items-center gap-1 text-sm">
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
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="text-neutral-500 hidden md:inline">
              {session?.user.email}
            </span>
            <button
              onClick={async () => {
                await signOut();
                navigate("/", { replace: true });
              }}
              className="rounded-md border border-neutral-800 px-3 py-1.5 text-neutral-300 hover:border-neutral-600 hover:text-white"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
    </div>
  );
}
