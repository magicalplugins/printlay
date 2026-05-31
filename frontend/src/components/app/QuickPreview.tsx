import { useEffect, useRef, useState } from "react";
import { Shape } from "../../api/templates";

interface QuickPreviewProps {
  pageWidth: number;
  pageHeight: number;
  shapes: Shape[];
  className?: string;
}

/**
 * Eyeball icon button that shows a mini SVG layout preview on click.
 * Used in Jobs, Templates, and Sheets lists for quick visual identification.
 */
export default function QuickPreview({
  pageWidth,
  pageHeight,
  shapes,
  className = "",
}: QuickPreviewProps) {
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (
        popRef.current &&
        !popRef.current.contains(e.target as Node) &&
        btnRef.current &&
        !btnRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const maxDim = 240;
  const aspect = pageWidth / pageHeight;
  const svgW = aspect >= 1 ? maxDim : Math.round(maxDim * aspect);
  const svgH = aspect >= 1 ? Math.round(maxDim / aspect) : maxDim;

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((v) => !v);
        }}
        className="p-1 rounded hover:bg-neutral-700/60 text-neutral-500 hover:text-violet-400 transition"
        title="Quick preview"
        aria-label="Quick preview"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>
      {open && (
        <div
          ref={popRef}
          className="absolute z-50 top-full mt-1 left-1/2 -translate-x-1/2 rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl p-3"
          onClick={(e) => e.stopPropagation()}
        >
          <svg
            width={svgW}
            height={svgH}
            viewBox={`0 0 ${pageWidth} ${pageHeight}`}
            className="rounded-md bg-white"
          >
            {shapes.map((s, i) => {
              const [x1, y1, x2, y2] = s.bbox;
              const x = x1;
              const y = y1;
              const w = x2 - x1;
              const h = y2 - y1;
              const cx = x + w / 2;
              const cy = y + h / 2;
              const sw = Math.max(1, pageWidth * 0.003);

              if (s.kind === "ellipse") {
                return (
                  <ellipse
                    key={i}
                    cx={cx}
                    cy={cy}
                    rx={w / 2}
                    ry={h / 2}
                    fill="none"
                    stroke="#8B5CF6"
                    strokeWidth={sw}
                  />
                );
              }
              return (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={s.corner_radius_pt ?? 0}
                  ry={s.corner_radius_pt ?? 0}
                  fill="none"
                  stroke="#8B5CF6"
                  strokeWidth={sw}
                />
              );
            })}
          </svg>
          <div className="text-[10px] text-neutral-500 mt-1.5 text-center">
            {Math.round((pageWidth * 25.4) / 72)} × {Math.round((pageHeight * 25.4) / 72)} mm · {shapes.length} slot{shapes.length !== 1 ? "s" : ""}
          </div>
        </div>
      )}
    </span>
  );
}
