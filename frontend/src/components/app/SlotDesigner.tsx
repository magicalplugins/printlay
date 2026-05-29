import { ReactNode, useEffect, useRef, useState } from "react";
import {
  offsetPolygonPx,
  pointsToClipPath,
  pointsToPx,
  pointsToSvg,
} from "../../utils/polygon";

const PT_PER_MM = 72.0 / 25.4;

export type SlotPlacement = {
  /** Free-form rotation in degrees (will be snapped to 0/90/180/270 by the
   *  compositor in Phase 1; full angle-respecting placement comes later). */
  rotation_deg: number;
  fit_mode: "contain" | "cover" | "stretch" | "manual";
  /** Slot-local coords in mm. Origin = slot top-left. Negative or
   *  oversized values are intentional - that's how users opt into bleed. */
  x_mm: number;
  y_mm: number;
  w_mm: number | null;
  h_mm: number | null;
  /** Visual filter id applied to the artwork. Matches IDs in
   *  `backend/services/image_filters.py`. "none" preserves vector
   *  fidelity through the compositor; anything else triggers the
   *  rasterised path. Older saved placements may omit this; readers
   *  must default to "none". */
  filter_id?: string;
  /** When true, the visible/printable area shrinks from slot+bleed
   *  to slot-safe — anything the user designed *outside* the safe
   *  rectangle becomes a uniform white border. Position/scale/rotation
   *  of the artwork are NOT mutated; only the clip boundary tightens.
   *  Lets the user design freely and then "frame" the result with one
   *  click. Older saved placements may omit this; readers must
   *  default to `false`. */
  safe_crop?: boolean;
};

/** Shape of each filter preset. The CSS string is applied directly to the
 *  preview <img> so users get instant feedback; the matching backend
 *  filter (same `id`) is baked in at PDF render time. */
export type FilterPreset = {
  id: string;
  label: string;
  /** CSS `filter` value, mirrors the Pillow operation backend-side. */
  css: string;
};

/** Curated 12 - "Original" plus 11 of the most common social-media looks.
 *  The CSS values here are intentionally close (but not identical) to
 *  the Pillow recipes in `backend/services/image_filters.py`. Perfect
 *  parity isn't possible across the two engines; the goal is "the
 *  preview looks recognisably the same as the printed result". */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: "none", label: "Original", css: "none" },
  { id: "bw", label: "B&W", css: "grayscale(1)" },
  { id: "sepia", label: "Sepia", css: "sepia(0.85)" },
  { id: "vintage", label: "Vintage", css: "sepia(0.35) saturate(0.7) contrast(0.85)" },
  { id: "faded", label: "Faded", css: "saturate(0.6) contrast(0.78) brightness(1.08)" },
  { id: "vivid", label: "Vivid", css: "saturate(1.5) contrast(1.15)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.4)" },
  { id: "cool", label: "Cool", css: "hue-rotate(-12deg) saturate(1.05) brightness(1.02)" },
  { id: "warm", label: "Warm", css: "hue-rotate(8deg) saturate(1.1) brightness(1.02)" },
  { id: "clarendon", label: "Clarendon", css: "contrast(1.2) saturate(1.35)" },
  { id: "aden", label: "Aden", css: "saturate(0.85) brightness(1.1) hue-rotate(-15deg)" },
  { id: "moon", label: "Moon", css: "grayscale(1) brightness(1.1) contrast(1.15)" },
  { id: "invert", label: "Invert", css: "invert(1)" },
];

export function filterCss(id: string | undefined | null): string {
  const preset = FILTER_PRESETS.find((f) => f.id === (id || "none"));
  return preset?.css || "none";
}

type Props = {
  open: boolean;
  onClose: () => void;
  onSave: (p: SlotPlacement) => void;
  /** Slot size in PDF points (= the slot bbox width/height). */
  slotWidthPt: number;
  slotHeightPt: number;
  /** Geometric kind of the slot. Drives the cut line + bleed/safe shapes.
   *  `"rect"` (default) draws a rectangle; `"ellipse"` draws an oval that
   *  fits the bbox (which is a circle when the bbox is square);
   *  `"polygon"` draws the exact custom-shape path from the imported PDF. */
  shapeKind?: "rect" | "ellipse" | "polygon";
  /** Polygon vertices normalised to the slot bbox (`[u, v]` ∈ [0, 1]).
   *  Required when `shapeKind === "polygon"`; ignored otherwise. */
  shapePath?: [number, number][];
  /** Corner radius in mm for rect slots. Ignored when shapeKind is ellipse
   *  or polygon. */
  cornerRadiusMm?: number;
  /** Per-template tolerances in mm. Read-only here - bleed is a template
   *  setting and edited from the template page, not the designer. */
  bleedMm: number;
  safeMm: number;
  /** Current placement to seed the designer with. */
  initial: SlotPlacement;
  /** Asset to design. */
  thumbnailUrl: string | null;
  /** Asset's natural aspect ratio. Used for "Fit" / "Fill" presets and to
   *  preserve proportions when dragging corners. If unknown, the
   *  designer measures it from the loaded thumbnail. */
  assetAspectRatio?: number;
  /** Asset's natural physical size in mm (from the source file's actual
   *  dimensions). When provided, the artwork opens at this size centred in
   *  the slot - matching what a designer would expect ("if my SVG is
   *  58x78 mm, show it at 58x78 mm"). Falls back to a contain-fit when
   *  unknown. */
  assetNaturalWmm?: number;
  assetNaturalHmm?: number;
  assetName?: string;
};

type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

type Drag =
  | { kind: "move"; startX: number; startY: number; startBox: Box }
  | {
      kind: "resize";
      handle: Handle;
      startX: number;
      startY: number;
      startBox: Box;
    }
  | null;

type Box = { x: number; y: number; w: number; h: number };

export default function SlotDesigner({
  open,
  onClose,
  onSave,
  slotWidthPt,
  slotHeightPt,
  shapeKind = "rect",
  shapePath,
  cornerRadiusMm = 0,
  bleedMm,
  safeMm,
  initial,
  thumbnailUrl,
  assetAspectRatio,
  assetNaturalWmm,
  assetNaturalHmm,
  assetName,
}: Props) {
  const slotWmm = slotWidthPt / PT_PER_MM;
  const slotHmm = slotHeightPt / PT_PER_MM;

  // View zoom (only affects the on-screen rendering of the stage, not any
  // saved data). Lets the user shrink the canvas in the modal so they can
  // drag corner handles beyond the canvas edge to scale the artwork past
  // the cut line (anything outside the cut is trimmed at print).
  const [viewZoom, setViewZoom] = useState<number>(1);

  const [aspect, setAspect] = useState<number | null>(
    assetAspectRatio ??
      (assetNaturalWmm && assetNaturalHmm && assetNaturalHmm > 0
        ? assetNaturalWmm / assetNaturalHmm
        : null)
  );
  const [box, setBox] = useState<Box>(() =>
    clampBox(
      initialBox(initial, slotWmm, slotHmm, assetNaturalWmm, assetNaturalHmm),
      slotWmm,
      slotHmm,
      bleedMm,
      null
    )
  );
  const [rotation, setRotation] = useState<number>(() => initial.rotation_deg || 0);
  const [lockAspect, setLockAspect] = useState(true);
  const [filterId, setFilterId] = useState<string>(initial.filter_id || "none");
  // Safe-crop is a non-destructive frame: it tightens the clip mask from
  // slot+bleed down to slot-safe so the user gets a uniform white border
  // around what they designed, without touching their actual placement.
  // Decoupled from `box`/`rotation`/`filterId` so toggling it on/off is
  // reversible — the user can flip back to keep editing whenever.
  const [safeCrop, setSafeCrop] = useState<boolean>(
    () => Boolean(initial.safe_crop) && safeMm > 0
  );
  // Modules panel ("filters" today; future modules added here).
  const [activeModule, setActiveModule] = useState<"filters" | null>(null);

  // History stack for Undo. We snapshot the user-facing state every time
  // a meaningful change settles (drag end, slider release, filter pick,
  // rotate snap, fit/centre press). The current state is *not* on the
  // stack - only previous states are - so popping always lands on
  // something different than what's on screen.
  type Snapshot = { box: Box; rotation: number; filterId: string; safeCrop: boolean };
  const historyRef = useRef<Snapshot[]>([]);
  const [historyVersion, setHistoryVersion] = useState(0);

  const stageRef = useRef<HTMLDivElement>(null);
  const [stageW, setStageW] = useState(560);
  const [stageH, setStageH] = useState(520);
  const dragRef = useRef<Drag>(null);
  // Pre-drag snapshot so we can push it onto history exactly once when
  // the gesture settles (instead of one push per pixel of mouse move).
  const dragStartSnapshotRef = useRef<Snapshot | null>(null);

  // Reset state whenever modal re-opens with new content.
  useEffect(() => {
    if (!open) return;
    setAspect(
      assetAspectRatio ??
        (assetNaturalWmm && assetNaturalHmm && assetNaturalHmm > 0
          ? assetNaturalWmm / assetNaturalHmm
          : null)
    );
    setBox(
      clampBox(
        initialBox(initial, slotWmm, slotHmm, assetNaturalWmm, assetNaturalHmm),
        slotWmm,
        slotHmm,
        bleedMm,
        null
      )
    );
    setRotation(initial.rotation_deg || 0);
    setFilterId(initial.filter_id || "none");
    setSafeCrop(Boolean(initial.safe_crop) && safeMm > 0);
    historyRef.current = [];
    setHistoryVersion((v) => v + 1);
  }, [open, initial, slotWmm, slotHmm, bleedMm, safeMm, assetAspectRatio, assetNaturalWmm, assetNaturalHmm]);

  function snapshot(): Snapshot {
    return { box: { ...box }, rotation, filterId, safeCrop };
  }

  function pushHistory(snap?: Snapshot) {
    historyRef.current = [...historyRef.current, snap ?? snapshot()].slice(-50);
    setHistoryVersion((v) => v + 1);
  }

  function undo() {
    const stack = historyRef.current;
    if (stack.length === 0) return;
    const prev = stack[stack.length - 1];
    historyRef.current = stack.slice(0, -1);
    setBox(clampBox(prev.box, slotWmm, slotHmm, bleedMm, null));
    setRotation(prev.rotation);
    setFilterId(prev.filterId);
    setSafeCrop(Boolean(prev.safeCrop) && safeMm > 0);
    setHistoryVersion((v) => v + 1);
  }

  // When the natural aspect becomes known *late* (no width_pt was passed
  // and we had to read it from the loaded <img>), seed an initial box that
  // shows the artwork un-distorted. We don't refit if we already had
  // natural dimensions up-front, and we don't override a saved manual
  // placement either.
  useEffect(() => {
    if (!aspect) return;
    if (initial.fit_mode === "manual") return;
    if (assetNaturalWmm && assetNaturalHmm) return;
    const ar = aspect;
    let w = slotWmm;
    let h = slotWmm / ar;
    if (h > slotHmm) {
      h = slotHmm;
      w = slotHmm * ar;
    }
    setBox(
      clampBox(
        { x: (slotWmm - w) / 2, y: (slotHmm - h) / 2, w, h },
        slotWmm,
        slotHmm,
        bleedMm,
        null
      )
    );
    // Only run when aspect first becomes known for this open session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aspect]);

  // Re-clamp any time bleed shrinks so the box stays inside the canvas.
  useEffect(() => {
    setBox((b) => clampBox(b, slotWmm, slotHmm, bleedMm, lockAspect ? aspect : null));
  }, [bleedMm, slotWmm, slotHmm, lockAspect, aspect]);

  // Measure stage so we can compute mm→px scale. Both width and height are
  // tracked so the canvas always fits the actual viewport (full-screen
  // modal grows/shrinks with window or device rotation).
  useEffect(() => {
    if (!open) return;
    const el = stageRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      if (r.width > 0) setStageW(r.width);
      if (r.height > 0) setStageH(r.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  // Close on ESC, the universal "get out of full-screen" reflex.
  // Also handle Cmd/Ctrl+Z for undo.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, onClose]);

  // Compute scale: fit the slot + bleed into the available stage area.
  // Margin is a px gutter around the canvas so users always have room to
  // drag handles past its edges (cover-style cropping). Smaller margin on
  // narrow viewports to avoid wasting screen real estate.
  const margin = stageW < 600 ? 24 : 56;
  const drawWmm = slotWmm + bleedMm * 2;
  const drawHmm = slotHmm + bleedMm * 2;
  // Auto-fit, then apply user-controlled view zoom. Zoom < 1 shrinks the
  // canvas so there's empty stage around it - that empty space is where
  // resize handles can travel when the user wants to scale the artwork
  // beyond the canvas (cover-style cropping).
  const fitScale = Math.max(
    1,
    Math.min(
      (stageW - margin * 2) / drawWmm,
      (Math.max(stageH, 320) - margin * 2) / drawHmm
    )
  );
  const scale = fitScale * viewZoom;

  const slotPxW = slotWmm * scale;
  const slotPxH = slotHmm * scale;
  const safePx = safeMm * scale;
  const bleedPx = bleedMm * scale;
  const cornerPx = Math.max(
    0,
    Math.min(cornerRadiusMm * scale, Math.min(slotPxW, slotPxH) / 2)
  );
  const drawWpx = drawWmm * scale;
  const drawHpx = drawHmm * scale;

  // Centre the (slot + bleed) horizontally and vertically within the
  // measured stage. Falls back to a sensible minimum height before the
  // ResizeObserver has reported a real value (first paint).
  const effectiveStageH = Math.max(stageH, drawHpx + margin * 2, 320);
  const slotOriginX = Math.max(margin, (stageW - drawWpx) / 2) + bleedPx;
  const slotOriginY = Math.max(margin, (effectiveStageH - drawHpx) / 2) + bleedPx;

  const boxPx = {
    x: slotOriginX + box.x * scale,
    y: slotOriginY + box.y * scale,
    w: box.w * scale,
    h: box.h * scale,
  };

  function onPointerDownStage(e: React.PointerEvent, drag: Drag) {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = drag;
    // Capture pre-drag state so undo lands on the box as it was BEFORE
    // this whole gesture, not on whatever interim mouse-move emitted.
    dragStartSnapshotRef.current = snapshot();
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    const dxScreenMm = (e.clientX - d.startX) / scale;
    const dyScreenMm = (e.clientY - d.startY) / scale;
    if (d.kind === "move") {
      setBox(
        clampBox(
          {
            ...d.startBox,
            x: d.startBox.x + dxScreenMm,
            y: d.startBox.y + dyScreenMm,
          },
          slotWmm,
          slotHmm,
          bleedMm,
          lockAspect ? aspect : null
        )
      );
      return;
    }

    // 8-handle resize. Edge midpoint handles (n/s/e/w) move only the
    // edge they are on (free stretch / skew in one axis). Corner handles
    // (nw/ne/sw/se) move two edges and respect aspect lock when on.
    //
    // The box stores unrotated geometry (box.x/y/w/h) but is rendered
    // rotated around its own centre. Two consequences when rotation != 0:
    //   1. Screen-space pointer deltas must be projected onto the
    //      image's local axes before being applied to left/right/top/
    //      bottom, otherwise the user sees the image scale on the wrong
    //      axis and the edge handles appear to preserve aspect.
    //   2. Resizing a single edge changes the box's centre in slot-local
    //      coordinates, which - because the rotation pivots around that
    //      centre - drags the *opposite* edge across the screen unless
    //      we compensate. We re-anchor the opposite edge midpoint (or
    //      diagonally opposite corner) so the part of the artwork the
    //      user isn't grabbing stays put visually.
    const sb = d.startBox;
    const theta = (rotation * Math.PI) / 180;
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    // Project screen delta onto image-local axes. The image's local
    // x-axis points along (cosT, sinT) in slot space; its y-axis along
    // (-sinT, cosT). Dot-product gives us how much the user "pushed"
    // each handle in image space.
    const du = dxScreenMm * cosT + dyScreenMm * sinT;
    const dv = -dxScreenMm * sinT + dyScreenMm * cosT;

    const movesE = d.handle.includes("e");
    const movesW = d.handle.includes("w");
    const movesS = d.handle.includes("s");
    const movesN = d.handle.includes("n");
    const isCorner = (movesN || movesS) && (movesE || movesW);

    let left = sb.x + (movesW ? du : 0);
    let right = sb.x + sb.w + (movesE ? du : 0);
    let top = sb.y + (movesN ? dv : 0);
    let bottom = sb.y + sb.h + (movesS ? dv : 0);

    // Prevent the box from inverting through itself.
    if (movesW && left > right - 2) left = right - 2;
    if (movesE && right < left + 2) right = left + 2;
    if (movesN && top > bottom - 2) top = bottom - 2;
    if (movesS && bottom < top + 2) bottom = top + 2;

    let w = right - left;
    let h = bottom - top;

    // Aspect lock applies only to corner drags. Pulling an edge handle
    // always stretches in just that axis - that's why they exist.
    // The locked ratio is the box's CURRENT aspect (sb.w / sb.h), not
    // the asset's intrinsic aspect - so any prior edge-stretching is
    // preserved when the user later grabs a corner.
    if (isCorner && lockAspect && sb.w > 0 && sb.h > 0) {
      const lockRatio = sb.w / sb.h;
      if (w / h > lockRatio) {
        h = w / lockRatio;
        if (movesN) top = bottom - h;
        else bottom = top + h;
      } else {
        w = h * lockRatio;
        if (movesW) left = right - w;
        else right = left + w;
      }
    }

    // Anchor compensation. The "anchor" is the point of the box that
    // the user is NOT moving - its image-local offset from the centre
    // is the negative of the dragged handle's offset. We require that
    // anchor's screen-space position to be identical before and after
    // the resize; that's what stops the rest of the artwork from
    // sliding around as the user drags an edge of a rotated box.
    const handleOffXSign = movesE ? 1 : movesW ? -1 : 0;
    const handleOffYSign = movesS ? 1 : movesN ? -1 : 0;
    const anchorOldOffX = (-handleOffXSign * sb.w) / 2;
    const anchorOldOffY = (-handleOffYSign * sb.h) / 2;
    const anchorNewOffX = (-handleOffXSign * w) / 2;
    const anchorNewOffY = (-handleOffYSign * h) / 2;
    const dOffX = anchorOldOffX - anchorNewOffX;
    const dOffY = anchorOldOffY - anchorNewOffY;
    // Rotate the offset delta back into slot-local (screen-aligned) space.
    const screenDx = dOffX * cosT - dOffY * sinT;
    const screenDy = dOffX * sinT + dOffY * cosT;

    const oldCx = sb.x + sb.w / 2;
    const oldCy = sb.y + sb.h / 2;
    const newCx = oldCx + screenDx;
    const newCy = oldCy + screenDy;

    setBox(
      clampBox(
        { x: newCx - w / 2, y: newCy - h / 2, w, h },
        slotWmm,
        slotHmm,
        bleedMm,
        null
      )
    );
  }

  function onPointerUp(e: React.PointerEvent) {
    if (dragRef.current) {
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {}
      if (dragStartSnapshotRef.current) {
        pushHistory(dragStartSnapshotRef.current);
        dragStartSnapshotRef.current = null;
      }
    }
    dragRef.current = null;
  }

  function fitMode(mode: "contain" | "cover" | "stretch") {
    pushHistory();
    if (mode === "stretch") {
      setBox({ x: 0, y: 0, w: slotWmm, h: slotHmm });
      return;
    }
    const ar = aspect ?? slotWmm / slotHmm;
    let w = slotWmm;
    let h = slotWmm / ar;
    if (mode === "contain" ? h > slotHmm : h < slotHmm) {
      h = slotHmm;
      w = slotHmm * ar;
    }
    setBox({
      x: (slotWmm - w) / 2,
      y: (slotHmm - h) / 2,
      w,
      h,
    });
  }

  function reset() {
    pushHistory();
    fitMode("contain");
    setRotation(0);
    setFilterId("none");
  }

  // Toggle the non-destructive "safe crop" frame. When ON, the printable
  // window shrinks from slot+bleed down to slot-safe and everything the
  // user designed outside the safe rectangle becomes a uniform white
  // border. The artwork's box/rotation/filter are intentionally NOT
  // mutated — the user can flip safe-crop OFF at any time and the
  // original placement is exactly as they left it. Lets people design
  // freely first and "frame" with one click as a finishing step.
  function toggleSafeCrop() {
    if (safeMm <= 0) return;
    pushHistory();
    setSafeCrop((v) => !v);
  }

  // Centre the current box on the slot (the cut line, not the bleed canvas).
  // `axis` decides which direction(s): both, horizontal-only, vertical-only.
  // Size is preserved - this is purely a position move.
  function centre(axis: "both" | "h" | "v") {
    pushHistory();
    setBox((b) => {
      const nx = axis === "v" ? b.x : (slotWmm - b.w) / 2;
      const ny = axis === "h" ? b.y : (slotHmm - b.h) / 2;
      return clampBox(
        { ...b, x: nx, y: ny },
        slotWmm,
        slotHmm,
        bleedMm,
        null
      );
    });
  }

  // Scale slider behaviour: %-of-natural-size, scaled around the box's
  // current centre point so the artwork stays where the user put it.
  // We pin to the asset's natural aspect (not the user's stretched
  // aspect) - the slider's mental model is "size relative to the file
  // I uploaded", which is the only stable reference point.
  const naturalRefW =
    assetNaturalWmm && assetNaturalHmm
      ? assetNaturalWmm
      : aspect && aspect > 0
        ? slotWmm
        : slotWmm;
  const naturalRefH =
    assetNaturalWmm && assetNaturalHmm
      ? assetNaturalHmm
      : aspect && aspect > 0
        ? slotWmm / aspect
        : slotHmm;
  const scalePct = Math.round((box.w / naturalRefW) * 100);

  function applyScale(pct: number, snap: Snapshot | null = null) {
    if (snap) pushHistory(snap);
    const factor = Math.max(0.05, pct / 100);
    const newW = naturalRefW * factor;
    const newH = naturalRefH * factor;
    setBox((b) => {
      const cx = b.x + b.w / 2;
      const cy = b.y + b.h / 2;
      return clampBox(
        { x: cx - newW / 2, y: cy - newH / 2, w: newW, h: newH },
        slotWmm,
        slotHmm,
        bleedMm,
        null
      );
    });
  }

  function setRotationWithHistory(deg: number) {
    pushHistory();
    setRotation(deg);
  }

  function pickFilter(id: string) {
    if (id === filterId) return;
    pushHistory();
    setFilterId(id);
  }

  function save() {
    onSave({
      rotation_deg: ((rotation % 360) + 360) % 360,
      fit_mode: "manual",
      x_mm: round2(box.x),
      y_mm: round2(box.y),
      w_mm: round2(box.w),
      h_mm: round2(box.h),
      filter_id: filterId,
      safe_crop: safeCrop && safeMm > 0,
    });
    onClose();
  }

  if (!open) return null;

  // Touch the version so React re-renders when the underlying history
  // ref mutates - the Undo button reads `historyRef.current.length`
  // directly and can't observe the change otherwise.
  void historyVersion;

  return (
    <div
      className="fixed inset-0 z-50 bg-neutral-950 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label="Artwork designer"
    >
      {/* Top bar: title + dimensions on the left, prominent Close on the right.
          Sticky so it survives keyboard pop-ups on iPad/mobile. */}
      <div className="shrink-0 flex items-center justify-between gap-3 px-4 sm:px-6 py-3 border-b border-neutral-900 bg-neutral-950/95 backdrop-blur">
        <div className="min-w-0 flex-1">
          <h2 className="text-sm sm:text-base font-semibold text-neutral-100 truncate">
            Designer
            {assetName && (
              <span className="text-neutral-500 font-normal ml-2 text-xs sm:text-sm">
                · {assetName}
              </span>
            )}
          </h2>
          <p className="text-[10px] sm:text-[11px] text-neutral-500 mt-0.5 truncate">
            <span className="text-fuchsia-300">cut</span>{" "}
            {slotWmm.toFixed(1)} × {slotHmm.toFixed(1)} mm
            {" · "}
            <span className={bleedMm > 0 ? "text-rose-300" : "text-neutral-600"}>
              canvas {(slotWmm + bleedMm * 2).toFixed(1)} × {(slotHmm + bleedMm * 2).toFixed(1)} mm
              {bleedMm > 0
                ? ` (cut + ${bleedMm}mm bleed)`
                : " (no bleed)"}
            </span>
            {safeMm > 0 && <> · <span className="text-sky-300">safe {safeMm}mm</span></>}
          </p>
        </div>
        <button
          onClick={onClose}
          className="shrink-0 inline-flex items-center gap-2 h-11 px-3 sm:px-4 rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-300 hover:text-white hover:border-neutral-600 hover:bg-neutral-800 active:bg-neutral-700 transition-colors text-sm font-medium"
          aria-label="Close designer (Esc)"
          title="Close (Esc)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
            <path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <span className="hidden sm:inline">Close</span>
        </button>
      </div>

      <div
        ref={stageRef}
        className="relative flex-1 min-h-0 bg-neutral-900/40 select-none overflow-hidden"
        style={{ touchAction: "none" }}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
          {/* Unified white design canvas = slot bbox + bleed on every side.
              This whole area is the artwork's playable region. Anything
              outside the cut line (drawn on top) will be trimmed at print
              but is still part of the design - that's what bleed is for.
              Artwork is clamped so it can't be dragged past this canvas.
              When bleed > 0 we draw a clear red dashed boundary at the
              outer edge so the bleed region reads as a deliberate zone. */}
          <div
            className="absolute bg-white"
            style={{
              left: slotOriginX - bleedPx,
              top: slotOriginY - bleedPx,
              width: slotPxW + bleedPx * 2,
              height: slotPxH + bleedPx * 2,
              outline: bleedPx > 0
                ? "1.5px dashed rgba(244,63,94,0.7)"
                : undefined,
              outlineOffset: -1,
            }}
          />

          {/* Artwork - draggable. Two layers so the user clearly sees what
              will actually print:
                1. Low-opacity copy at full box size (shows what will be
                   trimmed when the box extends past the slot+bleed area).
                2. Full-opacity copy clipped to the slot+bleed area (this
                   is exactly what the overlay/print will show).
              The interactive draggable + handles div sits on top with no
              image (the visible artwork is in the two layers below). */}
          {thumbnailUrl && (
            <>
              {/* Layer 1: ghost (the entire box, dimmed) */}
              <div
                className="absolute pointer-events-none"
                style={{
                  left: boxPx.x,
                  top: boxPx.y,
                  width: boxPx.w,
                  height: boxPx.h,
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: "center center",
                  opacity: 0.25,
                }}
              >
                <img
                  src={thumbnailUrl}
                  alt=""
                  draggable={false}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "fill",
                    pointerEvents: "none",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    display: "block",
                    filter: filterCss(filterId),
                  }}
                />
              </div>

              {/* Layer 2: full-opacity, clipped to the printable window.
                  Default = slot+bleed (everything down to the cut line).
                  When `safeCrop` is on, the window tightens to slot-safe
                  so anything the user designed outside the safe rect
                  becomes a uniform white border — print-shop "frame"
                  effect, applied non-destructively (toggle off and the
                  original layout is back, untouched). */}
              {(() => {
                const useSafe = safeCrop && safeMm > 0;
                const inset = useSafe ? -safePx : bleedPx;
                const wrapLeft = slotOriginX - inset;
                const wrapTop = slotOriginY - inset;
                const wrapW = slotPxW + inset * 2;
                const wrapH = slotPxH + inset * 2;
                const radius =
                  shapeKind === "ellipse"
                    ? "50%"
                    : cornerPx > 0
                      ? useSafe
                        ? `${Math.max(0, cornerPx - safePx)}px`
                        : `${cornerPx + bleedPx}px`
                      : 0;
                const clipPath =
                  shapeKind === "polygon" && shapePath && shapePath.length >= 3
                    ? (() => {
                        const slotPts = pointsToPx(
                          shapePath,
                          bleedPx,
                          bleedPx,
                          slotPxW,
                          slotPxH,
                        );
                        const offset = useSafe ? -safePx : bleedPx;
                        const adjusted = offsetPolygonPx(slotPts, offset);
                        const reNorm: [number, number][] = adjusted.map(
                          ([px, py]) => [
                            wrapW > 0 ? (px - (wrapLeft - (slotOriginX - bleedPx))) / wrapW : 0,
                            wrapH > 0 ? (py - (wrapTop - (slotOriginY - bleedPx))) / wrapH : 0,
                          ],
                        );
                        return pointsToClipPath(reNorm);
                      })()
                    : undefined;
                return (
              <div
                className="absolute pointer-events-none overflow-hidden"
                style={{
                  left: wrapLeft,
                  top: wrapTop,
                  width: wrapW,
                  height: wrapH,
                  borderRadius: clipPath ? 0 : radius,
                  clipPath,
                  WebkitClipPath: clipPath,
                  // White "matte" backdrop so an asset that doesn't fully
                  // cover the safe rect doesn't show the dimmed ghost
                  // through the gap — the user expects a clean white
                  // border, not a translucent one.
                  background: useSafe ? "white" : undefined,
                }}
              >
                <div
                  className="absolute"
                  style={{
                    left: boxPx.x - wrapLeft,
                    top: boxPx.y - wrapTop,
                    width: boxPx.w,
                    height: boxPx.h,
                    transform: `rotate(${rotation}deg)`,
                    transformOrigin: "center center",
                  }}
                >
                  <img
                    src={thumbnailUrl}
                    alt=""
                    draggable={false}
                    onLoad={(e) => {
                      if (aspect) return;
                      const img = e.currentTarget;
                      if (img.naturalWidth && img.naturalHeight) {
                        setAspect(img.naturalWidth / img.naturalHeight);
                      }
                    }}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "fill",
                      pointerEvents: "none",
                      userSelect: "none",
                      WebkitUserSelect: "none",
                      display: "block",
                      filter: filterCss(filterId),
                    }}
                  />
                </div>
              </div>
                );
              })()}

              {/* Layer 3: invisible interactive layer (drag + handles).
                  Sits on top so the user can grab the box even when the
                  visible artwork is dimmed/clipped underneath. */}
              <div
                className="absolute cursor-move"
                style={{
                  left: boxPx.x,
                  top: boxPx.y,
                  width: boxPx.w,
                  height: boxPx.h,
                  transform: `rotate(${rotation}deg)`,
                  transformOrigin: "center center",
                  touchAction: "none",
                }}
                onPointerDown={(e) =>
                  onPointerDownStage(e, {
                    kind: "move",
                    startX: e.clientX,
                    startY: e.clientY,
                    startBox: box,
                  })
                }
              >
              {/* Outline + handles. We render handles outside the rotation
                  so they stay visually upright? Simpler to keep them rotating
                  with the box - the corners themselves remain corners. */}
              <div
                className="absolute inset-0 pointer-events-none"
                style={{
                  outline: "1.5px solid rgba(168, 85, 247, 0.9)",
                  outlineOffset: -1,
                }}
              />
              {(
                ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const
              ).map((handle) => {
                const pos = handlePos(handle);
                const isEdge = handle.length === 1;
                return (
                  <div
                    key={handle}
                    onPointerDown={(e) =>
                      onPointerDownStage(e, {
                        kind: "resize",
                        handle,
                        startX: e.clientX,
                        startY: e.clientY,
                        startBox: box,
                      })
                    }
                    className={
                      isEdge
                        ? "absolute bg-white border-2 border-violet-500 rounded-sm shadow-md"
                        : "absolute bg-violet-500 border-2 border-white rounded-sm shadow-md"
                    }
                    style={{
                      width: 16,
                      height: 16,
                      left: `calc(${pos.x} - 8px)`,
                      top: `calc(${pos.y} - 8px)`,
                      cursor: handleCursor(handle),
                      touchAction: "none",
                    }}
                    title={isEdge ? "Stretch (this edge only)" : "Resize"}
                  />
                );
              })}
              </div>
            </>
          )}

          {/* Guide overlay: cut line + bleed + safe. Sits on TOP of the
              artwork so the cut edge is always visible (especially when
              artwork bleeds past it). For ellipse slots the cut is an oval
              that fits the bbox; bleed/safe are the same oval offset
              outward/inward. pointer-events-none so it never steals drag
              events from the artwork below. */}
          <svg
            className="absolute inset-0 pointer-events-none"
            width={stageW}
            height={effectiveStageH}
            style={{ overflow: "visible" }}
          >
            <defs>
              <filter id="cutGlow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="0" stdDeviation="2" floodColor="#ff2bd6" floodOpacity="0.55" />
              </filter>
            </defs>
            {shapeKind === "polygon" && shapePath && shapePath.length >= 3 ? (
              (() => {
                const polyPx = pointsToPx(
                  shapePath,
                  slotOriginX,
                  slotOriginY,
                  slotPxW,
                  slotPxH
                );
                const polyCut = pointsToSvg(polyPx);
                const polyBleed =
                  bleedPx > 0
                    ? pointsToSvg(offsetPolygonPx(polyPx, bleedPx))
                    : null;
                const polySafe =
                  safePx > 0
                    ? pointsToSvg(offsetPolygonPx(polyPx, -safePx))
                    : null;
                return (
                  <>
                    {polyBleed && (
                      <polygon
                        points={polyBleed}
                        fill="none"
                        stroke="rgba(244, 63, 94, 0.85)"
                        strokeWidth={1}
                        strokeDasharray="4 3"
                      />
                    )}
                    <polygon
                      points={polyCut}
                      fill="none"
                      stroke="#ff2bd6"
                      strokeWidth={1.75}
                      filter="url(#cutGlow)"
                    />
                    {polySafe && (
                      <polygon
                        points={polySafe}
                        fill="none"
                        stroke="rgba(56, 189, 248, 0.85)"
                        strokeWidth={1}
                        strokeDasharray="3 3"
                      />
                    )}
                  </>
                );
              })()
            ) : shapeKind === "ellipse" ? (
              <>
                {bleedPx > 0 && (
                  <ellipse
                    cx={slotOriginX + slotPxW / 2}
                    cy={slotOriginY + slotPxH / 2}
                    rx={slotPxW / 2 + bleedPx}
                    ry={slotPxH / 2 + bleedPx}
                    fill="none"
                    stroke="rgba(244, 63, 94, 0.85)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                )}
                <ellipse
                  cx={slotOriginX + slotPxW / 2}
                  cy={slotOriginY + slotPxH / 2}
                  rx={slotPxW / 2}
                  ry={slotPxH / 2}
                  fill="none"
                  stroke="#ff2bd6"
                  strokeWidth={1.75}
                  filter="url(#cutGlow)"
                />
                {safePx > 0 &&
                  slotPxW / 2 > safePx &&
                  slotPxH / 2 > safePx && (
                    <ellipse
                      cx={slotOriginX + slotPxW / 2}
                      cy={slotOriginY + slotPxH / 2}
                      rx={slotPxW / 2 - safePx}
                      ry={slotPxH / 2 - safePx}
                      fill="none"
                      stroke="rgba(56, 189, 248, 0.85)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                  )}
              </>
            ) : (
              <>
                {bleedPx > 0 && (
                  <rect
                    x={slotOriginX - bleedPx}
                    y={slotOriginY - bleedPx}
                    width={slotPxW + bleedPx * 2}
                    height={slotPxH + bleedPx * 2}
                    rx={cornerPx > 0 ? cornerPx + bleedPx : 0}
                    ry={cornerPx > 0 ? cornerPx + bleedPx : 0}
                    fill="none"
                    stroke="rgba(244, 63, 94, 0.85)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                  />
                )}
                <rect
                  x={slotOriginX}
                  y={slotOriginY}
                  width={slotPxW}
                  height={slotPxH}
                  rx={cornerPx}
                  ry={cornerPx}
                  fill="none"
                  stroke="#ff2bd6"
                  strokeWidth={1.75}
                  filter="url(#cutGlow)"
                />
                {safePx > 0 &&
                  slotPxW > safePx * 2 &&
                  slotPxH > safePx * 2 && (
                    <rect
                      x={slotOriginX + safePx}
                      y={slotOriginY + safePx}
                      width={slotPxW - safePx * 2}
                      height={slotPxH - safePx * 2}
                      rx={cornerPx > 0 ? Math.max(0, cornerPx - safePx) : 0}
                      ry={cornerPx > 0 ? Math.max(0, cornerPx - safePx) : 0}
                      fill="none"
                      stroke="rgba(56, 189, 248, 0.85)"
                      strokeWidth={1}
                      strokeDasharray="3 3"
                    />
                  )}
              </>
            )}
          </svg>

          {/* Tiny legend in the corner so users know what each guide means. */}
          <div className="absolute bottom-2 right-3 flex items-center gap-3 text-[10px] text-neutral-400 bg-neutral-950/70 backdrop-blur rounded-md px-2 py-1 pointer-events-none">
            <span className="flex items-center gap-1">
              <span
                className="inline-block w-3 h-0.5"
                style={{ background: "#ff2bd6" }}
              />
              Cut
            </span>
            {bleedMm > 0 && (
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-0.5"
                  style={{
                    background:
                      "repeating-linear-gradient(90deg, rgb(244,63,94) 0 3px, transparent 3px 5px)",
                  }}
                />
                Bleed
              </span>
            )}
            {safeMm > 0 && (
              <span className="flex items-center gap-1">
                <span
                  className="inline-block w-3 h-0.5"
                  style={{
                    background:
                      "repeating-linear-gradient(90deg, rgb(56,189,248) 0 3px, transparent 3px 5px)",
                  }}
                />
                Safe
              </span>
            )}
          </div>
        </div>

        {/* Controls panel - bottom of full-screen modal. Scrolls internally
            on short viewports so the stage above never gets clipped. The
            layout is grouped into compact toolbar rows; bleed is template-
            level and lives on the template page rather than here. */}
        <div className="shrink-0 max-h-[65vh] sm:max-h-[55vh] overflow-y-auto px-3 sm:px-6 py-3 border-t border-neutral-900 bg-neutral-950 space-y-2.5">
          {/* Row 1: 3 compact sliders side-by-side (View zoom, Rotate, Scale).
              Scale operates around the box's centre, so reducing the slider
              shrinks the artwork without it drifting off-position. Lock-
              aspect + Undo sit on the right and stay visible across all
              viewport widths. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <SliderControl
              id="design-view-zoom"
              label="View"
              min={0.5}
              max={1}
              step={0.05}
              value={viewZoom}
              onChange={(v) => setViewZoom(v)}
              valueLabel={`${Math.round(viewZoom * 100)}%`}
            />

            <SliderControl
              id="design-rotate"
              label="Rotate"
              min={0}
              max={359}
              step={1}
              value={Math.round(rotation)}
              onChange={(v) => setRotation(v)}
              onCommit={() => pushHistory()}
              valueLabel={`${Math.round(rotation)}°`}
              extra={
                <div className="flex items-center rounded-md border border-neutral-800 overflow-hidden">
                  {[0, 90, 180, 270].map((d) => {
                    const active = Math.round(rotation) % 360 === d;
                    return (
                      <button
                        key={d}
                        onClick={() => setRotationWithHistory(d)}
                        className={
                          "h-8 px-1.5 text-[10px] font-mono " +
                          (active
                            ? "bg-violet-500/15 text-violet-300"
                            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200")
                        }
                        title={`Rotate ${d}°`}
                      >
                        {d}°
                      </button>
                    );
                  })}
                </div>
              }
            />

            <SliderControl
              id="design-scale"
              label="Scale"
              min={10}
              max={200}
              step={1}
              value={Math.min(200, Math.max(10, scalePct))}
              onChange={(v) => applyScale(v, null)}
              onCommit={(v) => applyScale(v, snapshot())}
              valueLabel={`${scalePct}%`}
            />

            <button
              onClick={undo}
              disabled={historyRef.current.length === 0}
              aria-label="Undo last change"
              title={
                historyRef.current.length === 0
                  ? "Nothing to undo"
                  : `Undo (Ctrl/Cmd+Z) · ${historyRef.current.length} step${historyRef.current.length === 1 ? "" : "s"}`
              }
              className={
                "inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border text-xs font-semibold transition-colors " +
                (historyRef.current.length === 0
                  ? "border-neutral-800 bg-neutral-950 text-neutral-600 cursor-not-allowed"
                  : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:text-white")
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                <path
                  d="M5.5 3 2 6.5 5.5 10M2 6.5h6.2a3.3 3.3 0 0 1 0 6.5H7"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Undo</span>
            </button>

            {/* Lock aspect: deliberately heavier than the rest. This is the
                #1 toggle people forget exists, so it gets a real button look
                with a clear icon-state and label. */}
            <button
              onClick={() => setLockAspect((v) => !v)}
              aria-pressed={lockAspect}
              className={
                "inline-flex items-center gap-2 h-9 px-3 rounded-lg border text-xs font-semibold transition-colors " +
                (lockAspect
                  ? "border-violet-500 bg-violet-500/15 text-violet-200 hover:bg-violet-500/20"
                  : "border-neutral-700 bg-neutral-900 text-neutral-300 hover:border-neutral-500 hover:text-white")
              }
              title={
                lockAspect
                  ? "Aspect locked - corner drags scale uniformly"
                  : "Aspect unlocked - corner drags can stretch"
              }
            >
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
                {lockAspect ? (
                  <path
                    d="M3.5 6.5V4.5a3.5 3.5 0 1 1 7 0v2M3 6.5h8v5.5H3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : (
                  <path
                    d="M3.5 6.5V4.5a3.5 3.5 0 0 1 6.6-1.6M3 6.5h8v5.5H3z"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                )}
              </svg>
              <span className="hidden sm:inline">{lockAspect ? "Locked" : "Free"}</span>
            </button>
          </div>

          {/* Row 2: Fit presets, Centre helpers, and Modules drawer toggle. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-neutral-500 mr-1">
                Fit
              </span>
              <div className="flex items-center rounded-md border border-neutral-800 overflow-hidden">
                <button
                  onClick={() => fitMode("contain")}
                  className="h-8 px-2.5 text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white"
                  title="Scale to fit inside the slot, preserving proportions"
                >
                  Contain
                </button>
                <button
                  onClick={() => fitMode("cover")}
                  className="h-8 px-2.5 text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white border-l border-neutral-800"
                  title="Scale to fill the slot, preserving proportions (will crop)"
                >
                  Fill
                </button>
                <button
                  onClick={() => fitMode("stretch")}
                  className="h-8 px-2.5 text-[11px] text-neutral-300 hover:bg-neutral-900 hover:text-white border-l border-neutral-800"
                  title="Stretch to slot edges (distorts)"
                >
                  Stretch
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-[10px] uppercase tracking-widest text-neutral-500 mr-1">
                Centre
              </span>
              <div className="flex items-center rounded-md border border-neutral-800 overflow-hidden">
                <button
                  onClick={() => centre("both")}
                  className="h-8 px-2 text-neutral-300 hover:bg-neutral-900 hover:text-white inline-flex items-center"
                  title="Centre artwork on both axes"
                  aria-label="Centre both axes"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                    <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                    <circle cx="6" cy="6" r="1.6" fill="currentColor" />
                  </svg>
                </button>
                <button
                  onClick={() => centre("h")}
                  className="h-8 px-2 text-neutral-300 hover:bg-neutral-900 hover:text-white inline-flex items-center border-l border-neutral-800"
                  title="Centre artwork horizontally"
                  aria-label="Centre horizontally"
                >
                  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden>
                    <path d="M2 6h10M3 4l-2 2 2 2M11 4l2 2-2 2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
                <button
                  onClick={() => centre("v")}
                  className="h-8 px-2 text-neutral-300 hover:bg-neutral-900 hover:text-white inline-flex items-center border-l border-neutral-800"
                  title="Centre artwork vertically"
                  aria-label="Centre vertically"
                >
                  <svg width="12" height="14" viewBox="0 0 12 14" aria-hidden>
                    <path d="M6 2v10M4 3l2-2 2 2M4 11l2 2 2-2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" fill="none" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="flex-1" />

            {/* Safe crop toggle. Deliberately positioned AWAY from the fit
                presets — it's a non-destructive "finishing" step (frame
                everything outside the safe rect with white) rather than
                a layout operation. Stateful ON/OFF so the user can flip
                it back to keep editing. Hidden when the template defines
                no safe area (`safeMm === 0`) since the toggle would have
                nothing to clip to. */}
            {safeMm > 0 && (
              <button
                onClick={toggleSafeCrop}
                aria-pressed={safeCrop}
                className={
                  "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[11px] font-semibold transition-colors " +
                  (safeCrop
                    ? "border-sky-500 bg-sky-500/15 text-sky-200"
                    : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-sky-600 hover:text-sky-200")
                }
                title={
                  safeCrop
                    ? `Safe crop ON — printable area trimmed to inside the ${safeMm}mm safe line. Click to remove the frame and keep editing.`
                    : `Frame the design with a clean ${safeMm}mm white border. Non-destructive — your placement stays exactly as you set it.`
                }
              >
                <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden>
                  <rect
                    x="2.5" y="2.5" width="8" height="8"
                    fill="none" stroke="currentColor" strokeWidth="1.2"
                    strokeDasharray="1.5 1"
                  />
                  <rect
                    x="4.5" y="4.5" width="4" height="4"
                    fill="currentColor" fillOpacity="0.35"
                  />
                </svg>
                <span>Safe crop</span>
                {safeCrop && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-sky-400" />
                )}
              </button>
            )}

            {/* Modules drawer toggle. Today the only module is Filters but
                this is the place to plug in future ones (effects, masks,
                text overlays...). Active filter shows as a small dot so
                the user can see at-a-glance that something non-default is
                applied even when the drawer is closed. */}
            <button
              onClick={() =>
                setActiveModule((m) => (m === "filters" ? null : "filters"))
              }
              aria-pressed={activeModule === "filters"}
              className={
                "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg border text-[11px] font-semibold transition-colors " +
                (activeModule === "filters"
                  ? "border-violet-500 bg-violet-500/15 text-violet-200"
                  : "border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-neutral-600 hover:text-white")
              }
              title="Open filters & effects"
            >
              <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden>
                <circle cx="4.5" cy="4.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
                <circle cx="8.5" cy="8.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.2" />
              </svg>
              <span>Filters</span>
              {filterId !== "none" && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-fuchsia-400" />
              )}
              <svg
                width="9"
                height="9"
                viewBox="0 0 9 9"
                aria-hidden
                className={`transition-transform ${activeModule === "filters" ? "rotate-180" : ""}`}
              >
                <path d="M2 3.5 4.5 6 7 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
          </div>

          {activeModule === "filters" && (
            <ModulesPanel
              filterId={filterId}
              onPickFilter={pickFilter}
              previewSrc={thumbnailUrl}
              onClose={() => setActiveModule(null)}
            />
          )}

          {/* Numeric */}
          <div className="grid grid-cols-4 gap-2">
            {(
              [
                ["X", "x"],
                ["Y", "y"],
                ["W", "w"],
                ["H", "h"],
              ] as const
            ).map(([label, k]) => (
              <CropNumField
                key={k}
                label={label}
                value={round2(box[k])}
                onChange={(v) =>
                  setBox((b) =>
                    clampBox(
                      { ...b, [k]: v },
                      slotWmm,
                      slotHmm,
                      bleedMm,
                      lockAspect ? aspect : null
                    )
                  )
                }
              />
            ))}
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              onClick={reset}
              className="h-10 px-4 rounded-lg border border-neutral-800 text-sm hover:border-neutral-600"
            >
              Reset
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="h-10 px-4 rounded-lg border border-neutral-800 text-sm hover:border-neutral-600"
              >
                Cancel
              </button>
              <button
                onClick={save}
                className="h-10 px-5 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-white text-sm font-semibold hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20"
              >
                Save layout
              </button>
            </div>
          </div>
        </div>
      </div>
  );
}

/** Compact, label-free slider control used in the designer toolbar.
 *  Tight enough that three of these fit on a single laptop-width row.
 *  `onCommit` fires once on pointerup/blur so the parent can push a
 *  history snapshot - we keep `onChange` light so the slider is smooth
 *  during drag. */
function SliderControl(props: {
  id: string;
  label: string;
  min: number;
  max: number;
  step: number;
  value: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  valueLabel: string;
  extra?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1.5 min-w-[150px] flex-1">
      <label
        htmlFor={props.id}
        className="text-[10px] uppercase tracking-widest text-neutral-500 shrink-0"
      >
        {props.label}
      </label>
      <input
        id={props.id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
        onPointerUp={(e) =>
          props.onCommit?.(parseFloat((e.currentTarget as HTMLInputElement).value))
        }
        onKeyUp={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            props.onCommit?.(parseFloat((e.currentTarget as HTMLInputElement).value));
          }
        }}
        className="flex-1 accent-violet-500 h-8 min-w-[60px]"
        aria-label={props.label}
      />
      <span className="w-11 text-right font-mono text-[11px] text-neutral-300 tabular-nums shrink-0">
        {props.valueLabel}
      </span>
      {props.extra}
    </div>
  );
}

/** Collapsible drawer below the toolbar. Today: filter picker. Tomorrow:
 *  whatever else we need - the structure (tabbed, scrollable, mobile-
 *  friendly grid of icon tiles) generalises. Each tile shows a tiny
 *  preview of the filter applied to the current asset so users can
 *  compare looks at-a-glance. */
function ModulesPanel(props: {
  filterId: string;
  onPickFilter: (id: string) => void;
  previewSrc: string | null;
  onClose: () => void;
}) {
  const { filterId, onPickFilter, previewSrc } = props;
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-widest text-neutral-400 font-semibold">
          Filters
        </div>
        <button
          onClick={() => onPickFilter("none")}
          className="text-[10px] uppercase tracking-widest text-neutral-500 hover:text-neutral-200 transition-colors"
          title="Reset filter to original"
        >
          Reset
        </button>
      </div>
      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns:
            "repeat(auto-fill, minmax(72px, 1fr))",
        }}
      >
        {FILTER_PRESETS.map((p) => {
          const active = (filterId || "none") === p.id;
          return (
            <button
              key={p.id}
              onClick={() => onPickFilter(p.id)}
              className={
                "group flex flex-col items-center gap-1 rounded-lg p-1.5 border transition-all " +
                (active
                  ? "border-violet-500 bg-violet-500/10 ring-1 ring-violet-500/40"
                  : "border-neutral-800 bg-neutral-950 hover:border-neutral-600")
              }
              title={p.label}
              aria-pressed={active}
            >
              <div className="w-full aspect-square rounded-md overflow-hidden bg-neutral-900 flex items-center justify-center">
                {previewSrc ? (
                  <img
                    src={previewSrc}
                    alt=""
                    draggable={false}
                    style={{ filter: p.css }}
                    className="w-full h-full object-contain"
                  />
                ) : (
                  <span className="text-[9px] text-neutral-600 uppercase">{p.label[0]}</span>
                )}
              </div>
              <span
                className={
                  "text-[10px] truncate w-full text-center " +
                  (active ? "text-violet-200 font-semibold" : "text-neutral-400")
                }
              >
                {p.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function handlePos(h: Handle): { x: string; y: string } {
  const x = h.includes("w") ? "0%" : h.includes("e") ? "100%" : "50%";
  const y = h.includes("n") ? "0%" : h.includes("s") ? "100%" : "50%";
  return { x, y };
}

function handleCursor(h: Handle): string {
  switch (h) {
    case "n":
    case "s":
      return "ns-resize";
    case "e":
    case "w":
      return "ew-resize";
    case "nw":
    case "se":
      return "nwse-resize";
    case "ne":
    case "sw":
      return "nesw-resize";
  }
}

function initialBox(
  p: SlotPlacement,
  slotWmm: number,
  slotHmm: number,
  naturalWmm?: number,
  naturalHmm?: number
): Box {
  if (p.fit_mode === "manual" && p.w_mm && p.h_mm) {
    return { x: p.x_mm, y: p.y_mm, w: p.w_mm, h: p.h_mm };
  }
  // No saved manual placement. Prefer the asset's true physical size
  // (centred in the slot) - that's what a print designer expects: a
  // 58x78 mm SVG opens at exactly 58x78 mm, not stretched to fill the
  // slot. But if the natural size is drastically larger than the slot
  // (raster photos at 300 DPI), contain-fit so the image doesn't just
  // overflow and look like an unintentional full-bleed.
  if (naturalWmm && naturalHmm && naturalWmm > 0 && naturalHmm > 0) {
    let w = naturalWmm;
    let h = naturalHmm;
    if (w > slotWmm * 1.5 || h > slotHmm * 1.5) {
      const ar = w / h;
      w = slotWmm;
      h = slotWmm / ar;
      if (h > slotHmm) {
        h = slotHmm;
        w = slotHmm * ar;
      }
    }
    return {
      x: (slotWmm - w) / 2,
      y: (slotHmm - h) / 2,
      w,
      h,
    };
  }
  return { x: 0, y: 0, w: slotWmm, h: slotHmm };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Soft-clamp `box` so the artwork stays usable.
 *  Sizes are NOT capped - artwork may be larger than the canvas
 *  (cover-style cropping past the cut line is intentional).
 *  Position is clamped so the artwork always overlaps the canvas
 *  by at least `MIN_OVERLAP_MM`, otherwise it could be flung off
 *  screen and lost. `aspect` is unused here now; kept for API
 *  symmetry with prior calls. */
function clampBox(
  b: Box,
  slotWmm: number,
  slotHmm: number,
  bleedMm: number,
  _aspect: number | null
): Box {
  const MIN_SIZE = 2; // mm - prevents zero-size boxes
  const MIN_OVERLAP_MM = 5;

  const canvasMinX = -bleedMm;
  const canvasMinY = -bleedMm;
  const canvasMaxX = slotWmm + bleedMm;
  const canvasMaxY = slotHmm + bleedMm;

  const w = Math.max(MIN_SIZE, b.w);
  const h = Math.max(MIN_SIZE, b.h);

  // The box's right edge must be at least MIN_OVERLAP past the canvas
  // left edge, and its left edge must be at most MIN_OVERLAP before the
  // canvas right edge. This lets users push artwork well off canvas for
  // cover crops, while still preventing it from disappearing entirely.
  const overlap = Math.min(MIN_OVERLAP_MM, w, h);
  const xMin = canvasMinX - (w - overlap);
  const xMax = canvasMaxX - overlap;
  const yMin = canvasMinY - (h - overlap);
  const yMax = canvasMaxY - overlap;

  const x = Math.max(xMin, Math.min(b.x, xMax));
  const y = Math.max(yMin, Math.min(b.y, yMax));

  return { x, y, w, h };
}

function CropNumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  const [raw, setRaw] = useState(String(value));
  const prevRef = useRef(value);
  if (prevRef.current !== value && String(value) !== raw) {
    setRaw(String(value));
  }
  prevRef.current = value;

  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-0.5">
        {label} <span className="text-neutral-700">mm</span>
      </div>
      <input
        type="number"
        inputMode="decimal"
        step={0.5}
        value={raw}
        onChange={(e) => {
          setRaw(e.target.value);
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        onBlur={() => {
          const n = parseFloat(raw);
          if (Number.isNaN(n) || raw.trim() === "") {
            onChange(0);
            setRaw("0");
          } else {
            setRaw(String(n));
          }
        }}
        className="w-full h-9 rounded-md border border-neutral-800 bg-neutral-950 px-2 font-mono text-sm outline-none focus:border-violet-500"
      />
    </label>
  );
}
