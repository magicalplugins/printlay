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
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import SlotOverlay from "../components/app/SlotOverlay";
import { autoReparseIfStale } from "../utils/reparseTemplate";
import { formatApiError, FormattedApiError } from "../utils/apiError";

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
  // Blank by default for new jobs - we want the user to consciously
  // name the job, not silently inherit "Job — <template>" which led to
  // a wall of identically-named jobs in the list.
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showNameNudge, setShowNameNudge] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));

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
          const [tRaw, d] = await Promise.all([
            getTemplate(j.template_id),
            downloadTemplateUrl(j.template_id),
          ]);
          // Transparently upgrade legacy uploads so the slot overlay
          // shows the current parser's bboxes rather than the old
          // stroke-padded ones.
          const t = await autoReparseIfStale(tRaw);
          setTemplate(t);
          setPdfUrl(d.url);
        } else if (templateIdFromUrl) {
          const [tRaw, d] = await Promise.all([
            getTemplate(templateIdFromUrl),
            downloadTemplateUrl(templateIdFromUrl),
          ]);
          const t = await autoReparseIfStale(tRaw);
          setTemplate(t);
          setPdfUrl(d.url);
          // Intentionally leave `name` empty - see useState above.
        } else {
          setErr({ message: "No template specified.", suggestsUpgrade: false });
        }
      } catch (e) {
        reportErr(e);
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
    const epsilon = 6;
    const sorted = [...template.shapes]
      .sort((a, b) => {
        const [ax, ay] = a.bbox;
        const [bx, by] = b.bbox;
        if (Math.abs(ay - by) > epsilon) return ay - by;
        return ax - bx;
      })
      .map((s) => s.shape_index);
    setOrder(sorted);
  }

  function autoOrderColumns() {
    if (!template) return;
    const epsilon = 6;
    const sorted = [...template.shapes]
      .sort((a, b) => {
        const [ax, ay] = a.bbox;
        const [bx, by] = b.bbox;
        if (Math.abs(ax - bx) > epsilon) return ax - bx;
        return ay - by;
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
    const rx0 = rectPxX;
    const ry0 = rectPxY;
    const rx1 = rectPxX + rectPxW;
    const ry1 = rectPxY + rectPxH;
    const candidates = template.shapes
      .map((s) => {
        const [x, y, w, h] = s.bbox;
        const x0 = x * render.scale;
        const y0 = y * render.scale;
        const x1 = (x + w) * render.scale;
        const y1 = (y + h) * render.scale;
        return {
          idx: s.shape_index,
          x0,
          y0,
          x1,
          y1,
          cx: (x0 + x1) / 2,
          cy: (y0 + y1) / 2,
        };
      })
      .filter((c) => c.x0 < rx1 && c.x1 > rx0 && c.y0 < ry1 && c.y1 > ry0);
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
    if (w < 2 && h < 2) return;

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
    const trimmedName = name.trim();
    if (!trimmedName) {
      // Surface a non-blocking nudge + scroll the field into view.
      // The button is also disabled in this state, so this guard only
      // fires if a future caller (keyboard shortcut, etc.) bypasses the
      // disabled state.
      setShowNameNudge(true);
      const el = document.getElementById("job-name-input");
      el?.focus();
      el?.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (job) {
        const updated = await updateJob(job.id, { name: trimmedName, slot_order: order });
        navigate(`/app/jobs/${updated.id}/fill`);
      } else {
        const created = await createJob({
          template_id: template.id,
          name: trimmedName,
          slot_order: order,
        });
        navigate(`/app/jobs/${created.id}/fill`);
      }
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
    }
  }

  if (err)
    return (
      <div className="p-8 space-y-3">
        <QuotaErrorBanner error={err} />
        <Link
          to="/app/templates"
          className="inline-block text-sm text-neutral-400 underline hover:text-neutral-200"
        >
          Back to templates
        </Link>
      </div>
    );
  if (!template || !pdfUrl)
    return <div className="p-8 text-neutral-500">Loading…</div>;

  const trimmedName = name.trim();
  const nameMissing = trimmedName.length === 0;
  const showRedBorder = showNameNudge && nameMissing;
  const orderCount = order.length;
  const totalSlots = template.shapes.length;

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-6 py-4 sm:py-8 pb-64 sm:pb-40">
      <div className="mb-4 sm:mb-6">
        <Link to="/app/jobs" className="text-sm text-neutral-400 hover:text-white">
          ← Jobs
        </Link>
        {/* Step 1 intro - centred to mirror the Step 2 box at the
            bottom of the page, but bumped a notch larger so it reads
            as the dominant first action. The eyebrow uses a violet
            pill so it visually pairs with the violet ring on Step 2's
            input. */}
        <div className="mt-3 sm:mt-4 text-center">
          {isNew && (
            <span className="inline-block rounded-full border border-violet-500/40 bg-violet-500/10 px-3 py-1 text-sm font-bold uppercase tracking-widest text-violet-200">
              Step 1
            </span>
          )}
          <h1 className="text-2xl sm:text-4xl font-bold tracking-tight mt-3">
            {isNew ? "Program slots" : "Edit slot order"}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 mx-auto max-w-xl">
            <span className="text-neutral-200 font-medium">Tap each slot</span>{" "}
            in the order you want them numbered — tap again to remove. Or use
            an auto-order preset below.{" "}
            <span className="text-neutral-500 hidden sm:inline">
              (Tip: hold Shift and drag a box across multiple slots to add a row
              or region in one go.)
            </span>
          </p>
        </div>
        <div className="flex items-center justify-center gap-2 mt-4 flex-wrap">
          <span className="text-xs uppercase tracking-wide text-neutral-500 mr-1">
            Order
          </span>
          <button
            type="button"
            onClick={autoOrderRows}
            title="Row-major: left to right, then down to next row"
            className="group inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:border-violet-500/60 hover:bg-neutral-800 hover:text-white transition"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-neutral-400 group-hover:text-white"
            >
              <path d="M3 4 H17" />
              <polyline points="14,2 17,4 14,6" />
              <path d="M3 10 H17" />
              <polyline points="14,8 17,10 14,12" />
              <path d="M3 16 H17" />
              <polyline points="14,14 17,16 14,18" />
            </svg>
            Rows
          </button>
          <button
            type="button"
            onClick={autoOrderColumns}
            title="Column-major: top to bottom, then across to next column"
            className="group inline-flex items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 hover:border-violet-500/60 hover:bg-neutral-800 hover:text-white transition"
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 20 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-neutral-400 group-hover:text-white"
            >
              <path d="M4 3 V17" />
              <polyline points="2,14 4,17 6,14" />
              <path d="M10 3 V17" />
              <polyline points="8,14 10,17 12,14" />
              <path d="M16 3 V17" />
              <polyline points="14,14 16,17 18,14" />
            </svg>
            Columns
          </button>
          <span className="text-neutral-800">·</span>
          <button
            type="button"
            onClick={clearOrder}
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-400 hover:text-rose-400 transition"
          >
            Clear
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="relative block w-full max-w-[900px] mx-auto overflow-hidden bg-white rounded-lg shadow-2xl select-none ring-1 ring-neutral-800"
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
            bleedPt={(template.bleed_mm || 0) * (72 / 25.4)}
            safePt={(template.safe_mm || 0) * (72 / 25.4)}
            onShapeClick={onShapeClick}
          />
        )}
        {marquee?.active && (
          <div
            className="absolute pointer-events-none rounded border-2 border-cyan-400 bg-cyan-400/10"
            style={{
              left: Math.min(marquee.x0, marquee.x1),
              top: Math.min(marquee.y0, marquee.y1),
              width: Math.abs(marquee.x1 - marquee.x0),
              height: Math.abs(marquee.y1 - marquee.y0),
            }}
          />
        )}
      </div>

      {/* Static bottom action block. Pinned to the viewport so name +
          save are always one tap away regardless of scroll position.
          Centred horizontally and contains everything Step 2 needs:
          label, large centred input, Save Job button.

          For existing jobs (!isNew) the name field collapses out and
          we render a slimmer save-only bar. */}
      <div
        className="fixed bottom-0 inset-x-0 z-40 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="max-w-2xl mx-auto px-4 sm:px-6 py-3 sm:py-4">
          {isNew ? (
            <>
              <label
                htmlFor="job-name-input"
                className="block text-center text-[11px] uppercase tracking-widest text-violet-300/90 mb-2"
              >
                Step 2 · Enter job name{" "}
                <span className="text-rose-400 normal-case">required</span>
              </label>
              <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
                <input
                  id="job-name-input"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (e.target.value.trim()) setShowNameNudge(false);
                  }}
                  onKeyDown={(e) => {
                    // Pressing return on a phone keyboard should dismiss
                    // the keyboard and (if everything's ready) commit -
                    // matches the "Done"/"Go" key feel users expect.
                    if (e.key === "Enter") {
                      e.preventDefault();
                      (e.currentTarget as HTMLInputElement).blur();
                      if (!nameMissing && orderCount > 0 && !busy) save();
                    }
                  }}
                  placeholder="e.g. Wedding cards · 27 Apr"
                  /* Mobile-tap reliability: `touch-action: manipulation`
                     kills the 300ms tap delay & double-tap-to-zoom that
                     Safari adds to fixed-position inputs, which was
                     making the second tap feel unresponsive. The
                     autoComplete / autoCorrect attrs stop iOS from
                     overlaying its prediction bar on top of the field
                     and confusing the focus state. */
                  inputMode="text"
                  enterKeyHint="done"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="words"
                  spellCheck={false}
                  style={{ touchAction: "manipulation" }}
                  className={`flex-1 min-w-0 h-20 rounded-xl border-2 bg-neutral-950 px-5 text-3xl font-semibold text-center tracking-tight outline-none placeholder:text-base placeholder:font-normal placeholder:text-neutral-600 focus:border-violet-500 focus:ring-4 focus:ring-violet-500/20 ${
                    showRedBorder
                      ? "border-rose-500/70 ring-4 ring-rose-500/20"
                      : "border-neutral-800"
                  }`}
                />
                <button
                  type="button"
                  /* Use onPointerDown for an instant fire on touch -
                     onClick has to wait for the pointerup phase, and
                     when the on-screen keyboard is open iOS will use
                     that gap to dismiss the keyboard, eating the tap.
                     We still keep the disabled guard via `busy` and
                     the readiness checks so accidental taps don't
                     double-submit. */
                  onPointerDown={(e) => {
                    if (busy || orderCount === 0 || nameMissing) return;
                    // Defocus any active input first so the keyboard
                    // dismissal doesn't race with navigation.
                    (document.activeElement as HTMLElement | null)?.blur?.();
                    e.preventDefault();
                    save();
                  }}
                  /* Mouse/keyboard fallback (and assistive tech): in
                     case pointerdown didn't fire (very old browsers,
                     or programmatic activation via Enter on the
                     button), still honour the click. */
                  onClick={() => {
                    if (busy || orderCount === 0 || nameMissing) return;
                    save();
                  }}
                  disabled={busy || orderCount === 0 || nameMissing}
                  title={
                    nameMissing
                      ? "Enter a job name first"
                      : orderCount === 0
                      ? "Number at least one slot first"
                      : ""
                  }
                  /* Button colour is bound to "have we got a name yet":
                     plain white while the field is empty (low signal),
                     emerald gradient the moment any text lands so the
                     user gets immediate "you're nearly there" feedback.
                     Disabled state still applies if `orderCount === 0`,
                     but the green colour persists so the affordance
                     remains obvious. */
                  className={`shrink-0 h-20 rounded-xl px-7 text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed select-none ${
                    nameMissing
                      ? "bg-white text-neutral-950 hover:bg-neutral-200"
                      : "bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:from-emerald-400 hover:to-emerald-500 shadow-lg shadow-emerald-500/30"
                  }`}
                  style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
                >
                  {busy
                    ? "Saving…"
                    : nameMissing
                    ? "Enter name above"
                    : `Save Job (${orderCount}/${totalSlots})`}
                </button>
              </div>
              {showRedBorder && (
                <div className="mt-2 text-xs text-rose-300 text-center">
                  Give the job a name so you can find it again later.
                </div>
              )}
            </>
          ) : (
            <button
              type="button"
              onPointerDown={(e) => {
                if (busy || orderCount === 0) return;
                (document.activeElement as HTMLElement | null)?.blur?.();
                e.preventDefault();
                save();
              }}
              onClick={() => {
                if (busy || orderCount === 0) return;
                save();
              }}
              disabled={busy || orderCount === 0}
              className="w-full h-12 rounded-lg bg-white text-base font-semibold text-neutral-950 hover:bg-neutral-200 disabled:opacity-40 select-none"
              style={{ touchAction: "manipulation", WebkitTapHighlightColor: "transparent" }}
            >
              {busy ? "Saving…" : `Save (${orderCount}/${totalSlots}) →`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
