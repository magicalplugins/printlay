import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { deleteJob, duplicateJob, Job, listJobs } from "../api/jobs";
import { CardGridSkeleton } from "../components/Skeleton";

export default function Jobs() {
  const [items, setItems] = useState<Job[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const navigate = useNavigate();

  function load() {
    listJobs().then(setItems).catch((e) => setErr(String(e)));
  }
  useEffect(load, []);

  async function onDelete(id: string) {
    if (!confirm("Delete this job?")) return;
    await deleteJob(id);
    load();
  }

  async function onDuplicate(id: string) {
    try {
      const dup = await duplicateJob(id);
      navigate(`/app/jobs/${dup.id}/fill`);
    } catch (e) {
      setErr(String(e));
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Jobs</h1>
          <p className="text-neutral-400 mt-1">
            A job = a programmed slot order over a template, plus per-slot fills.
          </p>
        </div>
        <Link
          to="/app/templates"
          className="rounded-lg bg-white px-4 py-2.5 font-semibold text-neutral-950 hover:bg-neutral-200"
        >
          + Start a job from a template
        </Link>
      </div>

      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      {items === null ? (
        <CardGridSkeleton />
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
          No jobs yet. Open a template and click "Program slots →".
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {items.map((j) => {
            const filled = Object.keys(j.assignments).length;
            const total = j.slot_order.length;
            return (
              <div
                key={j.id}
                className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <div className="font-semibold">{j.name}</div>
                    <div className="text-xs text-neutral-500">
                      {filled}/{total} slots filled
                    </div>
                  </div>
                  <button
                    onClick={() => onDelete(j.id)}
                    className="text-xs text-neutral-500 hover:text-rose-400"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex gap-2 text-xs">
                  <Link
                    to={`/app/jobs/${j.id}/program`}
                    className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600"
                  >
                    Program
                  </Link>
                  <Link
                    to={`/app/jobs/${j.id}/fill`}
                    className="rounded-md bg-neutral-800 px-3 py-1.5 hover:bg-neutral-700"
                  >
                    Fill →
                  </Link>
                  <button
                    onClick={() => onDuplicate(j.id)}
                    className="rounded-md border border-neutral-800 px-3 py-1.5 hover:border-neutral-600 text-neutral-300"
                    title="Duplicate this job (preserves slot order + fills)"
                  >
                    Duplicate
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
