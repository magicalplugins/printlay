import { useEffect, useRef, useState } from "react";
import * as pdfjs from "pdfjs-dist";
import workerSrc from "pdfjs-dist/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type Props = {
  url: string;
  /** Width to render at (px). The canvas height auto-derives from page aspect. */
  width: number;
  onReady?: (info: { scale: number; pageWidth: number; pageHeight: number }) => void;
  className?: string;
};

export default function PdfCanvas({ url, width, onReady, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
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
        const scale = width / viewport1.width;
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d")!;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        renderTask = page.render({ canvasContext: ctx, viewport });
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
  }, [url, width, onReady]);

  if (err)
    return (
      <div className="text-rose-400 text-sm p-4 border border-rose-900/50 rounded-lg">
        PDF render failed: {err}
      </div>
    );

  return (
    <canvas
      ref={canvasRef}
      className={className ?? "rounded border border-neutral-800"}
      style={size ? { width: size.w, height: size.h } : undefined}
    />
  );
}
