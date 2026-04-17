import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import {
  createJob,
  getJob,
  Job,
  updateJob,
} from "../api/jobs";
import {
  downloadTemplateUrl,
  getTemplate,
  Shape,
  Template,
} from "../api/templates";
import PdfCanvas from "../components/app/PdfCanvas";
import SlotOverlay from "../components/app/SlotOverlay";

export default function JobProgrammer() {
  const params = useParams<{ id?: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();

  const isNew = !params.id;
  const templateIdFromUrl = search.get("template");

  const [job, setJob] = useState<Job | null>(null);
  const [template, setTemplate] = useState<Template | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [render, setRender] = useState<{ scale: number; pageWidth: number; pageHeight: number } | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [name, setName] = useState("New job");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement>(null);
  const [marquee, setMarquee] = useState<
    | { x0: number; y0: number; x1: number; y1: number; active: boolean }
    | null
  >(null);

  useEffect(() => {
    (async () => {
      try {
        if (params.id) {
          const j = await getJob(params.id);
          setJob(j);
          setName(j.name);
          setOrder(j.slot_order);
          const [t, d] = await Promise.all([
            getTemplate(j.template_id),
            downloadTemplateUrl(j.template_id),
          ]);
          setTemplate(t);
          setPdfUrl(d.url);
        } else if (templateIdFromUrl) {
          const [t, d] = await Promise.all([
            getTemplate(templateIdFromUrl),
            downloadTemplateUrl(templateIdFromUrl),
          ]);
          setTemplate(t);
          setPdfUrl(d.url);
          setName(`Job — ${t.name}`);
        } else {
          setErr("No template specified.");
        }
      } catch (e) {
        setErr(String(e));
      }
    })();
  }, [params.id, templateIdFromUrl]);

  const slotNumbers = useMemo(() => {
    const m: Record<number, number> = {};
    order.forEach((shapeIdx, i) => {
      m[shapeIdx] = i + 1;
    });
    return m;
  }, [order]);

  function onShapeClick(shape: Shape, e: React.MouseEvent<SVGElement>) {
    if (e.shiftKey) return;
    setOrder((prev) => {
      if (prev.includes(shape.shape_index)) {
        return prev.filter((x) => x !== shape.shape_index);
      }
      return [...prev, shape.shape_index];
    });
  }

  function autoOrderRows() {
    if (!template) return;
    const sorted = [...template.shapes]
      .sort((a, b) => {
        const [, ay] = a.bbox;
        const [, by] = b.bbox;
        const rowDiff = ay - by;
        const rowEpsilon = 6;
        if (Math.abs(rowDiff) > rowEpsilon) return rowDiff;
        return a.bbox[0] - b.bbox[0];
      })
      .map((s) => s.shape_index);
    setOrder(sorted);
  }

  function clearOrder() {
    setOrder([]);
  }

  function shapesInRect(
    rectPxX: number,
    rectPxY: number,
    rectPxW: number,
    rectPxH: number
  ): number[] {
    if (!template || !render) return [];
    const candidates = template.shapes
      .map((s) => {
        const [x, y, w, h] = s.bbox;
        const cx = (x + w / 2) * render.scale;
        const cy = (y + h / 2) * render.scale;
        return { idx: s.shape_index, cx, cy };
      })
      .filter(
        (c) =>
          c.cx >= rectPxX &&
          c.cx <= rectPxX + rectPxW &&
          c.cy >= rectPxY &&
          c.cy <= rectPxY + rectPxH
      );
    candidates.sort((a, b) => {
      const rowEpsilon = 6 * render.scale;
      if (Math.abs(a.cy - b.cy) > rowEpsilon) return a.cy - b.cy;
      return a.cx - b.cx;
    });
    return candidates.map((c) => c.idx);
  }

  function onStageMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!e.shiftKey) return;
    if (!stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    setMarquee({ x0: x, y0: y, x1: x, y1: y, active: true });
    e.preventDefault();
  }

  function onStageMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!marquee?.active || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    setMarquee({
      ...marquee,
      x1: e.clientX - r.left,
      y1: e.clientY - r.top,
    });
  }

  function onStageMouseUp() {
    if (!marquee?.active) return;
    const x = Math.min(marquee.x0, marquee.x1);
    const y = Math.min(marquee.y0, marquee.y1);
    const w = Math.abs(marquee.x1 - marquee.x0);
    const h = Math.abs(marquee.y1 - marquee.y0);
    setMarquee(null);
    if (w < 6 || h < 6) return;

    const swept = shapesInRect(x, y, w, h);
    if (swept.length === 0) return;
    setOrder((prev) => {
      const next = [...prev];
      for (const idx of swept) {
        if (!next.includes(idx)) next.push(idx);
      }
      return next;
    });
  }

  async function save() {
    if (!template) return;
    setBusy(true);
    setErr(null);
    try {
      if (job) {
        const updated = await updateJob(job.id, { name, slot_order: order });
        navigate(`/app/jobs/${updated.id}/fill`);
      } else {
        const created = await createJob({
          template_id: template.id,
          name,
          slot_order: order,
        });
        navigate(`/app/jobs/${created.id}/fill`);
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (err)
    return (
      <div className="p-8 text-rose-400">
        {err} · <Link to="/app/templates" className="underline">Back to templates</Link>
      </div>
    );
  if (!template || !pdfUrl)
    return <div className="p-8 text-neutral-500">Loading…</div>;

  return (
    <div className="max-w-7xl mx-auto px-6 py-8">
      <div className="flex items-start justify-between mb-6 gap-6 flex-wrap">
        <div>
          <Link to="/app/jobs" className="text-sm text-neutral-400 hover:text-white">
            ← Jobs
          </Link>
          <h1 className="text-3xl font-bold tracking-tight mt-2">
            {isNew ? "Program slots" : "Edit slot order"}
          </h1>
          <p className="text-neutral-400 text-sm mt-1">
            Click slots to number them. Click again to remove.{" "}
            <span className="text-neutral-300">Hold Shift + drag</span> to sweep
            a row/region in row-major order. Or use{" "}
            <button onClick={autoOrderRows} className="underline hover:text-white">
              auto-order rows
            </button>
            {" · "}
            <button onClick={clearOrder} className="underline hover:text-white">
              clear all
            </button>
          </p>
        </div>
        <div className="flex items-center gap-3">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-2 outline-none focus:border-neutral-600 w-72"
            placeholder="Job name"
          />
          <button
            onClick={save}
            disabled={busy || order.length === 0}
            className="rounded-lg bg-white px-5 py-2.5 font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40"
          >
            {busy ? "Saving…" : `Continue (${order.length}/${template.shapes.length}) →`}
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative inline-block bg-white rounded shadow-2xl select-none"
        onMouseDown={onStageMouseDown}
        onMouseMove={onStageMouseMove}
        onMouseUp={onStageMouseUp}
        onMouseLeave={onStageMouseUp}
      >
        <PdfCanvas url={pdfUrl} width={900} onReady={setRender} />
        {render && (
          <SlotOverlay
            shapes={template.shapes}
            pageWidthPt={render.pageWidth}
            pageHeightPt={render.pageHeight}
            scale={render.scale}
            slotNumbers={slotNumbers}
            onShapeClick={onShapeClick}
          />
        )}
        {marquee?.active && (
          <div
            className="absolute pointer-events-none border-2 border-amber-400 bg-amber-400/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
      </div>
    </div>
  );
}
