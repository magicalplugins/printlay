import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  downloadTemplateUrl,
  getTemplate,
  Template,
} from "../api/templates";
import PdfCanvas from "../components/app/PdfCanvas";
import SlotOverlay from "../components/app/SlotOverlay";

export default function TemplateDetail() {
  const { id } = useParams<{ id: string }>();
  const [tpl, setTpl] = useState<Template | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [renderInfo, setRenderInfo] = useState<{ scale: number; pageWidth: number; pageHeight: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    Promise.all([getTemplate(id), downloadTemplateUrl(id)])
      .then(([t, d]) => {
        setTpl(t);
        setPdfUrl(d.url);
      })
      .catch((e) => setErr(String(e)));
  }, [id]);

  if (err) return <div className="p-8 text-rose-400">{err}</div>;
  if (!tpl || !pdfUrl) return <div className="p-8 text-neutral-500">Loading…</div>;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link to="/app/templates" className="text-sm text-neutral-400 hover:text-white">
            ← Templates
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">{tpl.name}</h1>
          <p className="text-neutral-400 text-sm mt-1">
            {tpl.source} · {tpl.shapes.length} slots ·{" "}
            {Math.round(tpl.page_width)}×{Math.round(tpl.page_height)} pt ·{" "}
            {tpl.has_ocg ? (
              <span className="text-emerald-400">POSITIONS layer detected</span>
            ) : (
              <span className="text-amber-400">
                no POSITIONS layer — output will not hide slot rectangles
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
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

      <div className="relative inline-block bg-white rounded shadow-2xl">
        <PdfCanvas url={pdfUrl} width={900} onReady={setRenderInfo} />
        {renderInfo && (
          <SlotOverlay
            shapes={tpl.shapes}
            pageWidthPt={renderInfo.pageWidth}
            pageHeightPt={renderInfo.pageHeight}
            scale={renderInfo.scale}
          />
        )}
      </div>
    </div>
  );
}
