import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  downloadTemplateUrl,
  getTemplate,
  reparseTemplate,
  Template,
  updateTemplate,
} from "../api/templates";
import PdfCanvas from "../components/app/PdfCanvas";
import SlotOverlay from "../components/app/SlotOverlay";
import { autoReparseIfStale } from "../utils/reparseTemplate";

const MM_TO_PT = 72.0 / 25.4;

export default function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [renderInfo, setRenderInfo] = useState<{ scale: number; pageWidth: number; pageHeight: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bleed, setBleed] = useState<string>("0");
  const [safe, setSafe] = useState<string>("0");
  const [saving, setSaving] = useState(false);
  const [savedHint, setSavedHint] = useState(false);
  const [reparsing, setReparsing] = useState(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    (async () => {
      try {
        const [tRaw, d] = await Promise.all([
          getTemplate(id),
          downloadTemplateUrl(id),
        ]);
        if (cancelled) return;
        // Transparently upgrade legacy uploads to the latest parser
        // output before we render anything, so the slot overlay never
        // shows the old (mis-aligned) bboxes.
        const t = await autoReparseIfStale(tRaw);
        if (cancelled) return;
        setTpl(t);
        setPdfUrl(d.url);
        setBleed(String(t.bleed_mm ?? 0));
        setSafe(String(t.safe_mm ?? 0));
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function onReparse() {
    if (!tpl) return;
    if (
      !confirm(
        "Re-detect slots from the original PDF? This will replace the current slot layout. Existing jobs that reference this template by slot number may need re-programming if the slot order changes."
      )
    )
      return;
    setReparsing(true);
    try {
      const updated = await reparseTemplate(tpl.id);
      setTpl(updated);
    } catch (e) {
      setErr(String(e));
    } finally {
      setReparsing(false);
    }
  }

  async function onSaveBleedSafe() {
    if (!tpl) return;
    setSaving(true);
    try {
      const updated = await updateTemplate(tpl.id, {
        bleed_mm: Math.max(0, Math.min(20, parseFloat(bleed) || 0)),
        safe_mm: Math.max(0, Math.min(20, parseFloat(safe) || 0)),
      });
      setTpl(updated);
      setBleed(String(updated.bleed_mm));
      setSafe(String(updated.safe_mm));
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 1600);
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  if (err) return <div className="p-8 text-rose-400">{err}</div>;
  if (!tpl || !pdfUrl) return <div className="p-8 text-neutral-500">Loading…</div>;

  const liveBleedMm = Math.max(0, parseFloat(bleed) || 0);
  const liveSafeMm = Math.max(0, parseFloat(safe) || 0);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-8">
      <div className="flex items-center justify-between mb-6 gap-6 flex-wrap">
        <div>
          <Link to="/app/templates" className="text-sm text-neutral-400 hover:text-white">
            ← Templates
          </Link>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight mt-2">{tpl.name}</h1>
          <p className="text-neutral-400 text-sm mt-1">
            {tpl.source} · {tpl.shapes.length} slots ·{" "}
            {Math.round((tpl.page_width * 25.4) / 72)}×
            {Math.round((tpl.page_height * 25.4) / 72)} mm ·{" "}
            {tpl.has_ocg ? (
              <span className="text-emerald-400">POSITIONS layer detected</span>
            ) : (
              <span className="text-amber-400">
                no POSITIONS layer — output will not hide slot rectangles
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {tpl.source === "uploaded" && (
            <button
              type="button"
              onClick={onReparse}
              disabled={reparsing}
              className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600 disabled:opacity-50"
              title="Re-detect slot rectangles from the source PDF using the latest parser"
            >
              {reparsing ? "Re-detecting…" : "Re-detect slots"}
            </button>
          )}
          <a
            href={pdfUrl}
            download={`${tpl.name}.pdf`}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Download PDF
          </a>
          <Link
            to={`/app/jobs/new?template=${tpl.id}`}
            className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
          >
            Program slots →
          </Link>
        </div>
      </div>

      <div className="grid lg:grid-cols-[1fr_320px] gap-4 sm:gap-6 items-start">
        <div className="relative block w-full max-w-[900px] bg-white rounded shadow-2xl overflow-hidden">
          <PdfCanvas url={pdfUrl} width={900} onReady={setRenderInfo} />
          {renderInfo && (
            <SlotOverlay
              shapes={tpl.shapes}
              pageWidthPt={renderInfo.pageWidth}
              pageHeightPt={renderInfo.pageHeight}
              scale={renderInfo.scale}
              bleedPt={liveBleedMm * MM_TO_PT}
              safePt={liveSafeMm * MM_TO_PT}
            />
          )}
        </div>

        <aside className="space-y-4 lg:sticky lg:top-20">
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 p-4">
            <div className="text-xs uppercase tracking-widest text-neutral-500 mb-3">
              Print tolerances
            </div>
            <div className="space-y-3 text-sm">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-neutral-300 flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3 rounded-sm"
                      style={{
                        border: "1px dashed rgb(244, 63, 94)",
                        background: "rgba(244, 63, 94, 0.1)",
                      }}
                    />
                    Bleed
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      inputMode="decimal"
                      step={0.5}
                      min={0}
                      max={20}
                      value={bleed}
                      onChange={(e) => setBleed(e.target.value)}
                      className="w-16 h-9 rounded-md border border-neutral-800 bg-neutral-950 text-center font-mono outline-none focus:border-violet-500"
                    />
                    <span className="text-neutral-500 text-xs">mm</span>
                  </div>
                </div>
                <p className="text-[11px] text-neutral-500 leading-snug">
                  Allows artwork to extend this far past every slot edge.
                  Doesn't change the artboard size.
                </p>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-neutral-300 flex items-center gap-2">
                    <span
                      className="inline-block w-3 h-3 rounded-sm"
                      style={{
                        border: "1px dashed rgb(56, 189, 248)",
                      }}
                    />
                    Safe
                  </label>
                  <div className="flex items-center gap-1">
                    <input
                      type="number"
                      inputMode="decimal"
                      step={0.5}
                      min={0}
                      max={20}
                      value={safe}
                      onChange={(e) => setSafe(e.target.value)}
                      className="w-16 h-9 rounded-md border border-neutral-800 bg-neutral-950 text-center font-mono outline-none focus:border-violet-500"
                    />
                    <span className="text-neutral-500 text-xs">mm</span>
                  </div>
                </div>
                <p className="text-[11px] text-neutral-500 leading-snug">
                  Keep important artwork (logos, text) inside this margin.
                  Shown as a guide in the designer.
                </p>
              </div>

              <button
                onClick={onSaveBleedSafe}
                disabled={
                  saving ||
                  (Number(bleed) === tpl.bleed_mm && Number(safe) === tpl.safe_mm)
                }
                className="w-full mt-2 rounded-lg border border-neutral-800 hover:border-violet-500 px-3 py-2 text-sm font-medium disabled:opacity-40"
              >
                {savedHint ? "Saved ✓" : saving ? "Saving…" : "Save"}
              </button>
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
