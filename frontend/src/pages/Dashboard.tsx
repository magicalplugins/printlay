import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

type Me = {
  id: string;
  email: string;
  tier: string;
  is_active: boolean;
};

export default function Dashboard() {
  const [me, setMe] = useState<Me | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/auth/me")
      .then(setMe)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-6 py-12 space-y-10">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Welcome back</h1>
        <p className="text-neutral-400 mt-1">
          {me ? `Signed in as ${me.email} (${me.tier})` : "Loading…"}
          {err && <span className="text-rose-400 ml-2">{err}</span>}
        </p>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        <DashCard
          to="/app/templates/new"
          title="New template"
          body="Upload an Illustrator/PDF, or generate one from artboard + shape spec."
        />
        <DashCard
          to="/app/templates"
          title="Templates"
          body="Manage uploaded and generated templates."
        />
        <DashCard
          to="/app/jobs"
          title="Jobs"
          body="Programmed slot orders for a template — reuse across many fills."
        />
        <DashCard
          to="/app/catalogue"
          title="Catalogue"
          body="Categories of artwork. Import / export bundles to share with others."
        />
        <DashCard
          to="/app/outputs"
          title="Outputs"
          body="Print-ready PDFs you've generated. Download anytime."
        />
      </div>
    </div>
  );
}

function DashCard({
  to,
  title,
  body,
}: {
  to: string;
  title: string;
  body: string;
}) {
  return (
    <Link
      to={to}
      className="block rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 hover:border-neutral-600 transition"
    >
      <div className="font-semibold text-lg">{title}</div>
      <div className="text-sm text-neutral-400 mt-1">{body}</div>
    </Link>
  );
}
