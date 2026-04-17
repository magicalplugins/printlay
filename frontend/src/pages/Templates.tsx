import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { deleteTemplate, listTemplates, Template } from "../api/templates";
import { CardGridSkeleton } from "../components/Skeleton";

export default function Templates() {
  const [items, setItems] = useState<Template[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const data = await listTemplates();
      setItems(data);
    } catch (e) {
      setErr(String(e));
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(id: string) {
    if (!confirm("Delete this template? This cannot be undone.")) return;
    await deleteTemplate(id);
    load();
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Templates</h1>
          <p className="text-neutral-400 mt-1">
            Upload an Illustrator/PDF, or generate one from artboard + shape spec.
          </p>
        </div>
        <Link
          to="/app/templates/new"
          className="rounded-lg bg-white px-4 py-2.5 font-semibold text-neutral-950 hover:bg-neutral-200"
        >
          + New template
        </Link>
      </div>

      {err && <div className="text-sm text-rose-400 mb-4">{err}</div>}

      {items === null ? (
        <CardGridSkeleton />
      ) : items.length === 0 ? (
        <Empty />
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((t) => (
            <div
              key={t.id}
              className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{t.name}</div>
                  <div className="text-xs text-neutral-500">
                    {t.source} · {t.shapes.length} slots ·{" "}
                    {t.has_ocg ? (
                      <span className="text-emerald-400">POSITIONS layer ✓</span>
                    ) : (
                      <span className="text-amber-400">no POSITIONS layer</span>
                    )}
                  </div>
                  <div className="text-xs text-neutral-500 mt-0.5">
                    {Math.round(t.page_width)}×{Math.round(t.page_height)} pt
                  </div>
                </div>
                <button
                  onClick={() => onDelete(t.id)}
                  className="text-xs text-neutral-500 hover:text-rose-400"
                  title="Delete"
                >
                  ✕
                </button>
              </div>
              <div className="flex gap-2 text-xs">
                <Link
                  to={`/app/templates/${t.id}`}
                  className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600"
                >
                  Open
                </Link>
                <Link
                  to={`/app/jobs/new?template=${t.id}`}
                  className="rounded-md bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
                >
                  Program slots →
                </Link>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return (
    <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
      <div className="text-2xl mb-2">No templates yet</div>
      <p>Start by uploading an AI/PDF or generating a grid.</p>
      <Link
        to="/app/templates/new"
        className="inline-block mt-4 rounded-lg bg-white px-4 py-2 font-semibold text-neutral-950 hover:bg-neutral-200"
      >
        + New template
      </Link>
    </div>
  );
}
