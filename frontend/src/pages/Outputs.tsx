import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  deleteOutput,
  downloadOutputUrl,
  listOutputs,
  Output,
} from "../api/outputs";
import UsageHint from "../components/app/UsageHint";

export default function Outputs() {
  const [items, setItems] = useState<Output[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [search] = useSearchParams();
  const highlight = search.get("highlight");

  function load() {
    listOutputs().then(setItems).catch((e) => setErr(String(e)));
  }
  useEffect(load, []);

  async function onDownload(id: string) {
    // iPadOS / Safari blocks window.open() called after `await` because it's
    // no longer attached to a user gesture. Open a blank tab synchronously,
    // then redirect it once the presigned URL resolves. Falls back to a
    // same-tab navigation if the popup was suppressed entirely.
    const win = window.open("", "_blank");
    try {
      const { url } = await downloadOutputUrl(id);
      if (win && !win.closed) {
        win.location.href = url;
      } else {
        window.location.href = url;
      }
    } catch (e) {
      if (win && !win.closed) win.close();
      setErr(String(e));
    }
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this output PDF?")) return;
    await deleteOutput(id);
    load();
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-12">
      <div className="mb-8">
        <div className="flex items-center gap-3 flex-wrap">
          <h1 className="text-3xl font-bold tracking-tight">Outputs</h1>
          <UsageHint metric="exports_this_month" />
        </div>
        <p className="text-neutral-400 mt-1">
          Print-ready PDFs you've generated. Artboard preserved exact, slot
          rectangles hidden.
        </p>
      </div>

      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      {items === null ? (
        <ul className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <li
              key={i}
              className="h-16 rounded-xl border border-neutral-800 bg-neutral-900/50 animate-pulse"
            />
          ))}
        </ul>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
          Nothing yet. Fill a job and click "Generate PDF →".
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((o) => (
            <li
              key={o.id}
              className={`flex items-center justify-between gap-4 rounded-xl border p-4 ${
                highlight === o.id
                  ? "border-emerald-500/60 bg-emerald-500/5"
                  : "border-neutral-800 bg-neutral-900/50"
              }`}
            >
              <div className="min-w-0">
                <div className="font-semibold truncate">{o.name}</div>
                <div className="text-xs text-neutral-500">
                  {(o.file_size / 1024).toFixed(0)} KB · {o.slots_filled}/
                  {o.slots_total} slots filled ·{" "}
                  {new Date(o.created_at).toLocaleString()}
                </div>
              </div>
              <div className="flex gap-2 flex-shrink-0">
                <button
                  onClick={() => onDownload(o.id)}
                  className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
                >
                  Download
                </button>
                <button
                  onClick={() => onDelete(o.id)}
                  className="rounded-md border border-neutral-800 px-3 py-2 text-sm text-neutral-400 hover:border-rose-600 hover:text-rose-400"
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
