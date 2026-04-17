import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  Asset,
  Category,
  listAssets,
  listCategories,
} from "../api/catalogue";
import {
  fillJob,
  generateOutput,
  getJob,
  Job,
  updateJob,
} from "../api/jobs";
import {
  downloadTemplateUrl,
  getTemplate,
  Template,
} from "../api/templates";
import PdfCanvas from "../components/app/PdfCanvas";
import SlotOverlay from "../components/app/SlotOverlay";

export default function JobFiller() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [job, setJob] = useState<Job | null>(null);
  const [tpl, setTpl] = useState<Template | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [render, setRender] = useState<{ scale: number; pageWidth: number; pageHeight: number } | null>(null);

  const [cats, setCats] = useState<Category[] | null>(null);
  const [activeCat, setActiveCat] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);

  const [pendingAsset, setPendingAsset] = useState<Asset | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const j = await getJob(id);
        setJob(j);
        const [t, d, c] = await Promise.all([
          getTemplate(j.template_id),
          downloadTemplateUrl(j.template_id),
          listCategories(),
        ]);
        setTpl(t);
        setPdfUrl(d.url);
        setCats(c);
        if (c.length > 0) setActiveCat(c[0].id);
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!activeCat) {
      setAssets(null);
      return;
    }
    listAssets(activeCat).then(setAssets).catch((e) => setErr(String(e)));
  }, [activeCat]);

  const filledMap = useMemo(() => {
    const m: Record<number, number> = {};
    job?.slot_order.forEach((shapeIdx, i) => {
      const key = String(shapeIdx);
      if (job.assignments[key]) m[shapeIdx] = i + 1;
    });
    return m;
  }, [job]);

  const filledCount = job ? Object.keys(job.assignments).length : 0;
  const totalSlots = job?.slot_order.length ?? 0;
  const remaining = Math.max(0, totalSlots - filledCount);

  const visibleAssets = useMemo(() => {
    if (!assets) return null;
    const q = search.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(q));
  }, [assets, search]);

  async function applyFill(qty: number) {
    if (!job || !pendingAsset) return;
    setBusy(true);
    setErr(null);
    try {
      const updated = await fillJob(job.id, pendingAsset.id, qty);
      setJob(updated);
      setPendingAsset(null);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!job) return;
    if (!confirm("Clear all slot assignments?")) return;
    const updated = await updateJob(job.id, { assignments: {} });
    setJob(updated);
  }

  async function onGenerate() {
    if (!job) return;
    setGenerating(true);
    setErr(null);
    try {
      const out = await generateOutput(job.id);
      navigate(`/app/outputs?highlight=${out.id}`);
    } catch (e) {
      setErr(String(e));
    } finally {
      setGenerating(false);
    }
  }

  if (err && !job)
    return <div className="p-8 text-rose-400">{err}</div>;
  if (!job || !tpl || !pdfUrl)
    return <div className="p-8 text-neutral-500">Loading…</div>;

  return (
    <div className="max-w-[1600px] mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-6 gap-6 flex-wrap">
        <div>
          <Link to="/app/jobs" className="text-sm text-neutral-400 hover:text-white">
            ← Jobs
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">{job.name}</h1>
          <p className="text-neutral-400 text-sm mt-1">
            {filledCount}/{totalSlots} slots filled · {remaining} remaining
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            to={`/app/jobs/${job.id}/program`}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Re-program
          </Link>
          <button
            onClick={clearAll}
            disabled={filledCount === 0}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-rose-600 hover:text-rose-400 disabled:opacity-40"
          >
            Clear fills
          </button>
          <button
            onClick={onGenerate}
            disabled={generating || filledCount === 0}
            className="rounded-lg bg-emerald-500 px-5 py-2.5 font-semibold text-neutral-950 hover:bg-emerald-400 disabled:opacity-40"
          >
            {generating ? "Generating…" : "Generate PDF →"}
          </button>
        </div>
      </div>

      {err && <div className="mb-4 text-sm text-rose-400">{err}</div>}

      <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="relative inline-block bg-white rounded shadow-2xl">
          <PdfCanvas url={pdfUrl} width={900} onReady={setRender} />
          {render && (
            <SlotOverlay
              shapes={tpl.shapes}
              pageWidthPt={render.pageWidth}
              pageHeightPt={render.pageHeight}
              scale={render.scale}
              slotNumbers={filledMap}
            />
          )}
        </div>

        <aside className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4 lg:sticky lg:top-20">
          <div className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
            Categories
          </div>
          <div className="flex flex-wrap gap-2 mb-4">
            {cats?.length ? (
              cats.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveCat(c.id)}
                  className={`rounded-md px-3 py-1.5 text-xs font-medium transition ${
                    activeCat === c.id
                      ? "bg-white text-neutral-950"
                      : "bg-neutral-900 border border-neutral-800 text-neutral-300 hover:border-neutral-600"
                  }`}
                >
                  {c.name}
                </button>
              ))
            ) : (
              <Link
                to="/app/catalogue"
                className="text-sm text-neutral-400 underline"
              >
                No categories yet — create some →
              </Link>
            )}
          </div>

          <div className="flex items-center justify-between mb-2">
            <div className="text-xs uppercase tracking-widest text-neutral-500">
              Assets {visibleAssets && `(${visibleAssets.length})`}
            </div>
          </div>
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search assets…"
            className="w-full mb-3 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm outline-none focus:border-neutral-600"
          />
          <div className="grid grid-cols-3 gap-2 max-h-[60vh] overflow-y-auto">
            {assets?.length === 0 && (
              <div className="col-span-3 text-sm text-neutral-500 py-6 text-center">
                Empty category. Add assets in the catalogue.
              </div>
            )}
            {assets && assets.length > 0 && visibleAssets?.length === 0 && (
              <div className="col-span-3 text-sm text-neutral-500 py-6 text-center">
                No assets match "{search}".
              </div>
            )}
            {visibleAssets?.map((a) => (
              <button
                key={a.id}
                onClick={() => setPendingAsset(a)}
                className="aspect-square rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden hover:border-neutral-500 transition"
                title={a.name}
              >
                {a.thumbnail_url ? (
                  <img
                    src={a.thumbnail_url}
                    alt={a.name}
                    className="w-full h-full object-contain p-1"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center text-xs text-neutral-500 uppercase">
                    {a.kind}
                  </div>
                )}
              </button>
            ))}
          </div>
        </aside>
      </div>

      {pendingAsset && (
        <QuantityModal
          asset={pendingAsset}
          maxQuantity={remaining}
          busy={busy}
          onCancel={() => setPendingAsset(null)}
          onConfirm={applyFill}
        />
      )}
    </div>
  );
}

function QuantityModal({
  asset,
  maxQuantity,
  busy,
  onCancel,
  onConfirm,
}: {
  asset: Asset;
  maxQuantity: number;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (qty: number) => void;
}) {
  const [qty, setQty] = useState(Math.min(1, Math.max(1, maxQuantity)));
  const safeMax = Math.max(1, maxQuantity);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="bg-neutral-950 border border-neutral-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-4 items-start mb-4">
          <div className="h-20 w-20 rounded-lg border border-neutral-800 overflow-hidden bg-neutral-900 flex-shrink-0">
            {asset.thumbnail_url ? (
              <img src={asset.thumbnail_url} alt="" className="w-full h-full object-contain p-1" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-neutral-500">
                {asset.kind}
              </div>
            )}
          </div>
          <div>
            <div className="font-semibold">{asset.name}</div>
            <div className="text-xs text-neutral-500 mt-1">
              {Math.round(asset.width_pt)}×{Math.round(asset.height_pt)} pt
            </div>
            <div className="text-xs text-neutral-500">{maxQuantity} empty slots</div>
          </div>
        </div>
        <label className="block text-xs uppercase tracking-widest text-neutral-500 mb-2">
          How many?
        </label>
        <input
          type="number"
          min={1}
          max={safeMax}
          value={qty}
          onChange={(e) => setQty(Math.max(1, Math.min(safeMax, parseInt(e.target.value) || 1)))}
          className="w-full rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 text-2xl font-mono outline-none focus:border-neutral-600"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onConfirm(qty);
          }}
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={() => onConfirm(safeMax)}
            disabled={busy || maxQuantity === 0}
            className="flex-1 rounded-lg border border-neutral-800 px-4 py-2.5 text-sm hover:border-neutral-600 disabled:opacity-40"
          >
            Fill all ({safeMax})
          </button>
          <button
            onClick={onCancel}
            className="rounded-lg px-4 py-2.5 text-sm text-neutral-400 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(qty)}
            disabled={busy || maxQuantity === 0}
            className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
          >
            {busy ? "Filling…" : "Fill"}
          </button>
        </div>
      </div>
    </div>
  );
}
