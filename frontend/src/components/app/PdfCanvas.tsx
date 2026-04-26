import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type Props = {
  url: string;
  /** Maximum render width in CSS pixels. On mobile (or any container
   *  narrower than this) we shrink to fit so the canvas never causes
   *  horizontal scroll. The render is re-issued to keep it crisp - we
   *  never just CSS-scale a smaller canvas. */
  width: number;
  onReady?: (info: { scale: number; pageWidth: number; pageHeight: number }) => void;
  className?: string;
};

/**
 * Responsive PDF page renderer. Measures its own parent so the canvas
 * always fits the available width (capped at `width`). When the
 * parent resizes - rotation, drawer open, etc. - we re-render at the
 * new size so the page stays sharp on every device.
 */
export default function PdfCanvas({ url, width, onReady, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  // Start at 0 so we never render at a stale/default width on first
  // paint. The ResizeObserver sets the real value after one rAF once
  // the CSS layout has settled - this is the fix for iOS Safari showing
  // a zoomed-in canvas on first load.
  const [renderWidth, setRenderWidth] = useState<number>(0);

  // Track the parent's content-box width and clamp our render width to
  // it (capped at the caller's preferred max). Always debounced via rAF
  // - including the very first measurement - so the layout is settled
  // and clientWidth is reliable before we commit a canvas size.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    let raf = 0;
    const measure = () => {
      const parent = wrap.parentElement;
      const available = parent ? parent.clientWidth : window.innerWidth;
      const next = Math.max(120, Math.min(width, available));
      setRenderWidth((cur) => (Math.abs(cur - next) > 1 ? next : cur));
    };
    // Defer the initial measurement to after the first paint so that
    // flex/grid layout has fully resolved before we read clientWidth.
    raf = requestAnimationFrame(measure);
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    if (wrap.parentElement) ro.observe(wrap.parentElement);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [width]);

  useEffect(() => {
    // Wait until the layout measurement has fired at least once.
    if (renderWidth === 0) return;

    let cancelled = false;
    let renderTask: { cancel: () => void } | null = null;

    (async () => {
      try {
        const loadingTask = pdfjs.getDocument(url);
        const doc = await loadingTask.promise;
        if (cancelled) return;
        const page = await doc.getPage(1);
        if (cancelled) return;

        const viewport1 = page.getViewport({ scale: 1 });
        const scale = renderWidth / viewport1.width;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        // Print templates are paper-on-press, so the page background must
        // read as plain white. We pre-fill the canvas (some browsers /
        // pdfjs versions leave bare canvas regions transparent and the
        // dark app shell behind would bleed through), then ask pdfjs to
        // clear with white as well so that's belt-and-braces consistent.
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();

        renderTask = page.render({
          canvasContext: ctx,
          viewport,
          background: "rgb(255, 255, 255)",
        } as unknown as Parameters<typeof page.render>[0]);
        await (renderTask as unknown as { promise: Promise<void> }).promise;
        if (cancelled) return;

        setSize({ w: viewport.width, h: viewport.height });
        onReady?.({
          scale,
          pageWidth: viewport1.width,
          pageHeight: viewport1.height,
        });
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [url, renderWidth, onReady]);

  if (err)
    return (
      <div className="text-rose-400 text-sm p-4 border border-rose-900/50 rounded-lg">
        PDF render failed: {err}
      </div>
    );

  return (
    <div ref={wrapRef} className="contents">
      {/* Show a thin shimmer until the first real render lands so the
          container doesn't collapse to zero height before the canvas
          has measured its correct width. */}
      {!size && renderWidth === 0 && (
        <div className="w-full animate-pulse bg-neutral-200 rounded" style={{ minHeight: 120 }} />
      )}
      <canvas
        ref={canvasRef}
        className={className ?? "rounded border border-neutral-800"}
        style={{
          backgroundColor: "#ffffff",
          ...(size ? { width: size.w, height: size.h } : {}),
        }}
      />
    </div>
  );
}
