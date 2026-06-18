import {
  useCallback,
  useRef,
  useState,
} from "react";
import type { Asset } from "../../api/catalogue";
import type { Placement } from "../../api/sheets";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DtfItem {
  id: string;
  asset: Asset;
  x_mm: number;
  y_mm: number;
  w_mm: number;
  h_mm: number;
  rotation_deg: number;
}

interface SnapLine {
  axis: "x" | "y";
  pos: number;
}

interface Props {
  items: DtfItem[];
  sheetWidthMm: number;
  sheetHeightMm: number;
  onMove: (id: string, x: number, y: number) => void;
  onResize: (id: string, w: number, h: number) => void;
  onRotate: (id: string, deg: number) => void;
  onSelect: (id: string | null) => void;
  selectedId: string | null;
  mirrorPreview?: boolean;
}

const SNAP_THRESHOLD_MM = 2;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function DtfCanvas({
  items,
  sheetWidthMm,
  sheetHeightMm,
  onMove,
  onResize,
  onRotate,
  onSelect,
  selectedId,
  mirrorPreview,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragState, setDragState] = useState<{
    id: string;
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);
  const [resizeState, setResizeState] = useState<{
    id: string;
    startX: number;
    startY: number;
    origW: number;
    origH: number;
    aspect: number;
  } | null>(null);
  const [snapLines, setSnapLines] = useState<SnapLine[]>([]);
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const toSvg = useCallback(
    (e: React.PointerEvent | PointerEvent): { x: number; y: number } => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * sheetWidthMm;
      const y = ((e.clientY - rect.top) / rect.height) * sheetHeightMm;
      return { x, y };
    },
    [sheetWidthMm, sheetHeightMm]
  );

  // Snap detection against other items and sheet edges
  const computeSnaps = useCallback(
    (
      movingId: string,
      cx: number,
      cy: number,
      w: number,
      h: number
    ): { x: number; y: number; lines: SnapLine[] } => {
      const lines: SnapLine[] = [];
      let snapX = cx;
      let snapY = cy;

      const edges = {
        left: cx,
        right: cx + w,
        centerX: cx + w / 2,
        top: cy,
        bottom: cy + h,
        centerY: cy + h / 2,
      };

      // Snap to sheet edges
      const sheetTargetsX = [0, sheetWidthMm / 2, sheetWidthMm];
      const sheetTargetsY = [0, sheetHeightMm / 2, sheetHeightMm];

      for (const tx of sheetTargetsX) {
        if (Math.abs(edges.left - tx) < SNAP_THRESHOLD_MM) {
          snapX = tx;
          lines.push({ axis: "x", pos: tx });
        } else if (Math.abs(edges.right - tx) < SNAP_THRESHOLD_MM) {
          snapX = tx - w;
          lines.push({ axis: "x", pos: tx });
        } else if (Math.abs(edges.centerX - tx) < SNAP_THRESHOLD_MM) {
          snapX = tx - w / 2;
          lines.push({ axis: "x", pos: tx });
        }
      }

      for (const ty of sheetTargetsY) {
        if (Math.abs(edges.top - ty) < SNAP_THRESHOLD_MM) {
          snapY = ty;
          lines.push({ axis: "y", pos: ty });
        } else if (Math.abs(edges.bottom - ty) < SNAP_THRESHOLD_MM) {
          snapY = ty - h;
          lines.push({ axis: "y", pos: ty });
        } else if (Math.abs(edges.centerY - ty) < SNAP_THRESHOLD_MM) {
          snapY = ty - h / 2;
          lines.push({ axis: "y", pos: ty });
        }
      }

      // Snap to other items
      for (const item of items) {
        if (item.id === movingId) continue;
        const otherEdges = [
          item.x_mm,
          item.x_mm + item.w_mm,
          item.x_mm + item.w_mm / 2,
        ];
        const otherEdgesY = [
          item.y_mm,
          item.y_mm + item.h_mm,
          item.y_mm + item.h_mm / 2,
        ];

        for (const ox of otherEdges) {
          if (Math.abs(edges.left - ox) < SNAP_THRESHOLD_MM) {
            snapX = ox;
            lines.push({ axis: "x", pos: ox });
          } else if (Math.abs(edges.right - ox) < SNAP_THRESHOLD_MM) {
            snapX = ox - w;
            lines.push({ axis: "x", pos: ox });
          } else if (Math.abs(edges.centerX - ox) < SNAP_THRESHOLD_MM) {
            snapX = ox - w / 2;
            lines.push({ axis: "x", pos: ox });
          }
        }
        for (const oy of otherEdgesY) {
          if (Math.abs(edges.top - oy) < SNAP_THRESHOLD_MM) {
            snapY = oy;
            lines.push({ axis: "y", pos: oy });
          } else if (Math.abs(edges.bottom - oy) < SNAP_THRESHOLD_MM) {
            snapY = oy - h;
            lines.push({ axis: "y", pos: oy });
          } else if (Math.abs(edges.centerY - oy) < SNAP_THRESHOLD_MM) {
            snapY = oy - h / 2;
            lines.push({ axis: "y", pos: oy });
          }
        }
      }

      return { x: snapX, y: snapY, lines };
    },
    [items, sheetWidthMm, sheetHeightMm]
  );

  // Overlap detection
  const hasOverlap = useCallback(
    (id: string, x: number, y: number, w: number, h: number): boolean => {
      for (const item of items) {
        if (item.id === id) continue;
        const overlap =
          x < item.x_mm + item.w_mm &&
          x + w > item.x_mm &&
          y < item.y_mm + item.h_mm &&
          y + h > item.y_mm;
        if (overlap) return true;
      }
      return false;
    },
    [items]
  );

  // Push item to nearest non-overlapping position
  const resolveOverlap = useCallback(
    (id: string, x: number, y: number, w: number, h: number): { x: number; y: number } => {
      if (!hasOverlap(id, x, y, w, h)) return { x, y };
      const directions = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: -1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: -1 },
      ];
      for (let dist = 1; dist < 200; dist += 1) {
        for (const d of directions) {
          const nx = x + d.dx * dist;
          const ny = y + d.dy * dist;
          if (nx < 0 || ny < 0 || nx + w > sheetWidthMm || ny + h > sheetHeightMm) continue;
          if (!hasOverlap(id, nx, ny, w, h)) return { x: nx, y: ny };
        }
      }
      return { x, y };
    },
    [hasOverlap, sheetWidthMm, sheetHeightMm]
  );

  // Drag handlers
  const handlePointerDown = useCallback(
    (e: React.PointerEvent, item: DtfItem) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      onSelect(item.id);
      const pt = toSvg(e);
      setDragState({
        id: item.id,
        startX: pt.x,
        startY: pt.y,
        origX: item.x_mm,
        origY: item.y_mm,
      });
    },
    [onSelect, toSvg]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragState && !resizeState) return;
      const pt = toSvg(e);

      if (dragState) {
        const dx = pt.x - dragState.startX;
        const dy = pt.y - dragState.startY;
        let nx = dragState.origX + dx;
        let ny = dragState.origY + dy;
        const item = items.find((i) => i.id === dragState.id);
        if (!item) return;

        // Clamp to sheet bounds
        nx = Math.max(0, Math.min(sheetWidthMm - item.w_mm, nx));
        ny = Math.max(0, Math.min(sheetHeightMm - item.h_mm, ny));

        const snap = computeSnaps(dragState.id, nx, ny, item.w_mm, item.h_mm);
        setSnapLines(snap.lines);
        onMove(dragState.id, snap.x, snap.y);
      }

      if (resizeState) {
        const dx = pt.x - resizeState.startX;
        let newW = Math.max(5, resizeState.origW + dx);
        let newH = newW / resizeState.aspect;
        newW = Math.min(newW, sheetWidthMm);
        newH = Math.min(newH, sheetHeightMm);
        onResize(resizeState.id, newW, newH);
      }
    },
    [dragState, resizeState, toSvg, items, sheetWidthMm, sheetHeightMm, computeSnaps, onMove, onResize]
  );

  const [bouncingId, setBouncingId] = useState<string | null>(null);

  const handlePointerUp = useCallback(() => {
    if (dragState) {
      const item = items.find((i) => i.id === dragState.id);
      if (item) {
        const resolved = resolveOverlap(item.id, item.x_mm, item.y_mm, item.w_mm, item.h_mm);
        if (resolved.x !== item.x_mm || resolved.y !== item.y_mm) {
          onMove(item.id, resolved.x, resolved.y);
          setBouncingId(item.id);
          setTimeout(() => setBouncingId(null), 600);
        }
      }
    }
    setDragState(null);
    setResizeState(null);
    setSnapLines([]);
  }, [dragState, items, resolveOverlap, onMove]);

  const handleResizeDown = useCallback(
    (e: React.PointerEvent, item: DtfItem) => {
      e.stopPropagation();
      e.preventDefault();
      (e.target as Element).setPointerCapture(e.pointerId);
      const pt = toSvg(e);
      setResizeState({
        id: item.id,
        startX: pt.x,
        startY: pt.y,
        origW: item.w_mm,
        origH: item.h_mm,
        aspect: item.w_mm / item.h_mm,
      });
    },
    [toSvg]
  );

  const handleBgClick = useCallback(() => {
    onSelect(null);
  }, [onSelect]);

  return (
    <div
      className="relative rounded-xl border border-neutral-700 overflow-hidden bg-neutral-900"
      style={{ transform: mirrorPreview ? "scaleX(-1)" : undefined }}
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${sheetWidthMm} ${sheetHeightMm}`}
        className="w-full h-auto block select-none"
        style={{ minHeight: 200, maxHeight: "70vh" }}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={handleBgClick}
      >
        <style>{`
          @keyframes dtf-dash {
            to { stroke-dashoffset: -6; }
          }
        `}</style>
        {/* Sheet background */}
        <rect
          x={0}
          y={0}
          width={sheetWidthMm}
          height={sheetHeightMm}
          fill="white"
          stroke="#525252"
          strokeWidth={0.3}
        />

        {/* Grid lines (subtle) */}
        <GridPattern widthMm={sheetWidthMm} heightMm={sheetHeightMm} />

        {/* Placed items */}
        {items.map((item) => (
          <DragItem
            key={item.id}
            item={item}
            isSelected={item.id === selectedId}
            isHovered={item.id === hoveredId}
            isDragging={dragState?.id === item.id}
            isBouncing={bouncingId === item.id}
            onPointerDown={(e) => handlePointerDown(e, item)}
            onPointerEnter={() => setHoveredId(item.id)}
            onPointerLeave={() => setHoveredId(null)}
            onResizeDown={(e) => handleResizeDown(e, item)}
            onRotate={() => onRotate(item.id, (item.rotation_deg + 90) % 360)}
          />
        ))}

        {/* Snap guide lines */}
        {snapLines.map((line, i) =>
          line.axis === "x" ? (
            <line
              key={`snap-${i}`}
              x1={line.pos}
              y1={0}
              x2={line.pos}
              y2={sheetHeightMm}
              stroke="#818cf8"
              strokeWidth={0.4}
              strokeDasharray="1.5 1.5"
              className="pointer-events-none animate-pulse"
              opacity={0.8}
            />
          ) : (
            <line
              key={`snap-${i}`}
              x1={0}
              y1={line.pos}
              x2={sheetWidthMm}
              y2={line.pos}
              stroke="#818cf8"
              strokeWidth={0.4}
              strokeDasharray="1.5 1.5"
              className="pointer-events-none animate-pulse"
              opacity={0.8}
            />
          )
        )}

        {/* Snap intersection dots */}
        {snapLines.length >= 2 && (() => {
          const xLines = snapLines.filter(l => l.axis === "x");
          const yLines = snapLines.filter(l => l.axis === "y");
          const dots: React.ReactNode[] = [];
          for (const xl of xLines) {
            for (const yl of yLines) {
              dots.push(
                <circle
                  key={`dot-${xl.pos}-${yl.pos}`}
                  cx={xl.pos}
                  cy={yl.pos}
                  r={1.2}
                  fill="#818cf8"
                  className="pointer-events-none animate-ping"
                  opacity={0.9}
                />
              );
            }
          }
          return dots;
        })()}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function GridPattern({ widthMm, heightMm }: { widthMm: number; heightMm: number }) {
  const step = widthMm > 400 ? 50 : widthMm > 200 ? 20 : 10;
  const lines: React.ReactNode[] = [];
  for (let x = step; x < widthMm; x += step) {
    lines.push(
      <line
        key={`gx-${x}`}
        x1={x}
        y1={0}
        x2={x}
        y2={heightMm}
        stroke="#f0f0f0"
        strokeWidth={x % (step * 5) === 0 ? 0.25 : 0.1}
      />
    );
  }
  for (let y = step; y < heightMm; y += step) {
    lines.push(
      <line
        key={`gy-${y}`}
        x1={0}
        y1={y}
        x2={widthMm}
        y2={y}
        stroke="#f0f0f0"
        strokeWidth={y % (step * 5) === 0 ? 0.25 : 0.1}
      />
    );
  }
  return <>{lines}</>;
}

function DragItem({
  item,
  isSelected,
  isHovered,
  isDragging,
  isBouncing,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  onResizeDown,
  onRotate,
}: {
  item: DtfItem;
  isSelected: boolean;
  isHovered: boolean;
  isDragging: boolean;
  isBouncing: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onResizeDown: (e: React.PointerEvent) => void;
  onRotate: () => void;
}) {
  const thumbUrl = item.asset.thumbnail_url || "";
  const handleSize = Math.min(item.w_mm, item.h_mm) * 0.12;
  const hs = Math.max(2, Math.min(6, handleSize));

  return (
    <g
      className={isDragging ? "" : "transition-all duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]"}
      style={{
        filter: isDragging
          ? "drop-shadow(0 6px 12px rgba(0,0,0,0.5)) drop-shadow(0 2px 4px rgba(0,0,0,0.3))"
          : isSelected
          ? "drop-shadow(0 2px 4px rgba(99,102,241,0.3))"
          : undefined,
        opacity: isDragging ? 0.9 : 1,
        transform: isDragging
          ? "scale(1.03)"
          : isBouncing
          ? "scale(0.97)"
          : undefined,
        transformOrigin: `${item.x_mm + item.w_mm / 2}px ${item.y_mm + item.h_mm / 2}px`,
      }}
    >
      {/* Artwork image */}
      <image
        href={thumbUrl}
        x={item.x_mm}
        y={item.y_mm}
        width={item.w_mm}
        height={item.h_mm}
        preserveAspectRatio="xMidYMid meet"
        className="cursor-grab active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        onPointerLeave={onPointerLeave}
        style={{ touchAction: "none" }}
      />

      {/* Selection / hover outline */}
      {(isSelected || isHovered) && (
        <>
          <rect
            x={item.x_mm}
            y={item.y_mm}
            width={item.w_mm}
            height={item.h_mm}
            fill="none"
            stroke={isSelected ? "#818cf8" : "#a3a3a3"}
            strokeWidth={isSelected ? 0.6 : 0.3}
            strokeDasharray={isSelected ? "2 1" : "1.5 1"}
            className="pointer-events-none"
            style={isSelected ? { strokeDashoffset: 0, animation: "dtf-dash 1s linear infinite" } : undefined}
          />
          {/* Corner handles for selected */}
          {isSelected && (
            <>
              <circle cx={item.x_mm} cy={item.y_mm} r={0.8} fill="#818cf8" className="pointer-events-none" />
              <circle cx={item.x_mm + item.w_mm} cy={item.y_mm} r={0.8} fill="#818cf8" className="pointer-events-none" />
              <circle cx={item.x_mm} cy={item.y_mm + item.h_mm} r={0.8} fill="#818cf8" className="pointer-events-none" />
            </>
          )}
        </>
      )}

      {/* Resize handle (bottom-right) */}
      {isSelected && (
        <rect
          x={item.x_mm + item.w_mm - hs}
          y={item.y_mm + item.h_mm - hs}
          width={hs}
          height={hs}
          fill="#818cf8"
          rx={0.5}
          className="cursor-se-resize"
          onPointerDown={onResizeDown}
          style={{ touchAction: "none" }}
        />
      )}

      {/* Rotate handle (top-center) */}
      {isSelected && (
        <circle
          cx={item.x_mm + item.w_mm / 2}
          cy={item.y_mm - hs * 1.5}
          r={hs * 0.6}
          fill="#818cf8"
          className="cursor-pointer"
          onClick={(e) => {
            e.stopPropagation();
            onRotate();
          }}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Utility: convert DtfItems to Placement array for API
// ---------------------------------------------------------------------------

export function dtfItemsToplacements(items: DtfItem[]): Placement[] {
  return items.map((item) => ({
    asset_id: item.asset.id,
    x_mm: Math.round(item.x_mm * 100) / 100,
    y_mm: Math.round(item.y_mm * 100) / 100,
    rotation_deg: item.rotation_deg,
    scale: item.w_mm / (item.asset.width_pt * 25.4 / 72),
  }));
}

export function placementsToDtfItems(
  placements: Placement[],
  assets: Asset[]
): DtfItem[] {
  return placements
    .map((p, idx) => {
      const asset = assets.find((a) => a.id === p.asset_id);
      if (!asset) return null;
      const nativeW = asset.width_pt * 25.4 / 72;
      const nativeH = asset.height_pt * 25.4 / 72;
      return {
        id: `${p.asset_id}-${idx}`,
        asset,
        x_mm: p.x_mm,
        y_mm: p.y_mm,
        w_mm: nativeW * p.scale,
        h_mm: nativeH * p.scale,
        rotation_deg: p.rotation_deg,
      };
    })
    .filter(Boolean) as DtfItem[];
}
