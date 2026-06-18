import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, Ellipse, FabricImage, Rect, Textbox } from "fabric";
import {
  Type as TypeIcon,
  ImagePlus,
  Trash2,
  ArrowUp,
  ArrowDown,
  Bold,
  Italic,
  Eraser,
  Monitor,
  Smartphone,
} from "lucide-react";
import {
  EstimateResult,
  ProductConfig,
  WidgetApiError,
  WidgetClient,
} from "./widgetClient";
import { SizeUnit, fmtLen, mmToUnit, unitToMm } from "../utils/units";

const PRINT_DPI = 300;
const MM_PER_INCH = 25.4;

// Map a cut style to the canvas artboard shape + whether width/height are locked.
function shapeFor(style: string): { kind: "rect" | "ellipse"; lock: boolean; label: string } {
  switch (style) {
    case "circle":
      return { kind: "ellipse", lock: true, label: "Circle" };
    case "oval":
      return { kind: "ellipse", lock: false, label: "Oval" };
    case "rectangle":
      return { kind: "rect", lock: false, label: "Rectangle" };
    case "square":
    default:
      return { kind: "rect", lock: true, label: "Square" };
  }
}

const PALETTE = ["#ffffff", "#000000", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];
const FONTS = ["Inter, sans-serif", "Georgia, serif", "Impact, sans-serif", "Courier New, monospace"];

type ViewMode = "desktop" | "mobile";

/**
 * Numeric input that lets the user clear it and type freely. The committed
 * value is only clamped to [min, max] on blur / Enter, so typing "4" on the way
 * to "45" doesn't get snapped up to the minimum mid-keystroke.
 */
function NumField({
  value,
  min,
  max,
  onCommit,
  ariaLabel,
  decimals = 0,
}: {
  value: number;
  min: number;
  max: number;
  onCommit: (n: number) => void;
  ariaLabel?: string;
  decimals?: number;
}) {
  const [text, setText] = useState(String(value));
  // Reflect external value changes (e.g. square locks height to width).
  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) {
      setText(String(value));
      return;
    }
    const factor = Math.pow(10, decimals);
    const clamped = Math.min(max, Math.max(min, Math.round(n * factor) / factor));
    setText(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <input
      type="number"
      inputMode={decimals > 0 ? "decimal" : "numeric"}
      step={decimals > 0 ? 0.1 : 1}
      aria-label={ariaLabel}
      min={min}
      max={max}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/**
 * Full multi-layer designer for geometric (shaped) stickers. The artboard shape
 * is also the cut line, so there's no contour detection — the customer adds
 * text, images and shapes freely, picks a size, sees a live price, then we
 * flatten to a print-resolution PNG (clipped to the shape) and hand it to
 * `/canvas-finalize`.
 */
export default function ShapedDesigner({
  config,
  client,
  onDone,
}: {
  config: ProductConfig;
  client: WidgetClient;
  onDone: () => void;
}) {
  const styles = config.enabled_cut_styles.length
    ? config.enabled_cut_styles.filter((s) => ["square", "rectangle", "circle", "oval"].includes(s))
    : ["square"];
  const safeStyles = styles.length ? styles : ["square"];

  const [style, setStyle] = useState(safeStyles[0]);

  const clampMm = useCallback(
    (v: number) => Math.min(config.max_size_mm, Math.max(config.min_size_mm, v)),
    [config.min_size_mm, config.max_size_mm]
  );

  // Fixed sizes (presets) the merchant configured, plus optional custom entry.
  const presets = config.size_presets ?? [];
  const allowCustom = config.allow_custom_size !== false || presets.length === 0;
  // sizeSel: index into presets, or -1 for "custom".
  const [sizeSel, setSizeSel] = useState<number>(presets.length ? 0 : -1);

  const firstPreset = presets[0];
  const initSide = Math.round(clampMm(Math.min(100, config.max_size_mm)));
  const [widthMm, setWidthMm] = useState(firstPreset ? firstPreset.width_mm : initSide);
  const [heightMm, setHeightMm] = useState(firstPreset ? firstPreset.height_mm : initSide);
  const [unit, setUnit] = useState<SizeUnit>("cm");
  const dec = unit === "cm" ? 1 : 0;

  // Rounded corners for square/rectangle artboards (0..1 of half the short side).
  const [cornerRadius, setCornerRadius] = useState(
    typeof config.corner_radius === "number" ? config.corner_radius : 0.2
  );

  // A locked shape (square / circle) can be "unlocked" into its free variant
  // (rectangle / oval) so the customer can enter a second dimension, e.g. a
  // 40 × 60 rectangle or an oval — exactly like the admin template builder.
  const [unlocked, setUnlocked] = useState(
    firstPreset ? firstPreset.width_mm !== firstPreset.height_mm : false
  );
  // When the base shape changes, re-apply the active preset (or reset to locked).
  useEffect(() => {
    if (sizeSel >= 0 && presets[sizeSel]) {
      const p = presets[sizeSel];
      setUnlocked(p.width_mm !== p.height_mm);
      setWidthMm(p.width_mm);
      setHeightMm(p.height_mm);
    } else {
      setUnlocked(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [style]);
  const canUnlock = shapeFor(style).lock;
  const effectiveStyle = unlocked
    ? style === "circle"
      ? "oval"
      : style === "square"
        ? "rectangle"
        : style
    : style;
  const shape = useMemo(() => shapeFor(effectiveStyle), [effectiveStyle]);

  // Layout: full-screen two-pane on desktop, stacked card on mobile.
  const [viewMode, setViewMode] = useState<ViewMode>(() =>
    typeof window !== "undefined" && window.innerWidth < 760 ? "mobile" : "desktop"
  );

  const [vinyl, setVinyl] = useState<string | null>(config.vinyl_types[0]?.key ?? null);
  const [finish, setFinish] = useState<string | null>(config.finishes[0]?.key ?? null);
  const [quantity, setQuantity] = useState(50);
  const [bg, setBg] = useState("#ffffff");

  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [bgBusy, setBgBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [selIsImage, setSelIsImage] = useState(false);

  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const fcRef = useRef<Canvas | null>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  // Original uploaded file for each image object, so "remove background" can
  // re-send the source rather than a downscaled canvas render.
  const fileMapRef = useRef<WeakMap<object, File>>(new WeakMap());

  // Keep width/height in sync for locked (square/circle) shapes.
  useEffect(() => {
    if (shape.lock) setHeightMm(widthMm);
  }, [shape.lock, widthMm]);

  // Display geometry: fit the trim + bleed within a fixed box using a single
  // uniform scale, so aspect is preserved and the cut-line guide (which sits
  // OUTSIDE the trim) always stays within the stage. Desktop gets a larger
  // artboard than the compact mobile card.
  const DISPLAY_MAX = viewMode === "desktop" ? 480 : 340;
  const wMm = clampMm(widthMm);
  const hMm = clampMm(heightMm);
  const longestWithBleed = Math.max(wMm, hMm) + 2 * config.bleed_mm;
  const pxPerMm = DISPLAY_MAX / Math.max(1, longestWithBleed);
  const displayW = Math.max(1, Math.round(wMm * pxPerMm));
  const displayH = Math.max(1, Math.round(hMm * pxPerMm));
  const bleed = config.bleed_mm * pxPerMm;
  const safe = config.safe_mm * pxPerMm;
  const isEllipse = shape.kind === "ellipse";
  // Rounded-corner radius in display px (rectangles only).
  const radiusPx = isEllipse ? 0 : (cornerRadius * Math.min(displayW, displayH)) / 2;
  // The drawable artboard is the trim PLUS the bleed margin on every side, so
  // backgrounds/images run right to the bleed edge (no white slivers at the
  // cut). The cut line then sits INSET by the bleed, and the print export
  // includes the bleed — mirroring the admin "new template" sticker builder.
  const fullW = Math.max(1, Math.round((wMm + 2 * config.bleed_mm) * pxPerMm));
  const fullH = Math.max(1, Math.round((hMm + 2 * config.bleed_mm) * pxPerMm));

  const selectPreset = (i: number) => {
    const p = presets[i];
    if (!p) return;
    setSizeSel(i);
    setUnlocked(p.width_mm !== p.height_mm);
    setWidthMm(p.width_mm);
    setHeightMm(p.height_mm);
  };
  const selectCustom = () => setSizeSel(-1);

  // ---- Initialise / resize the Fabric canvas -----------------------------
  // Create the canvas ONCE on mount. When size changes, resize in place so
  // objects (text, images) are preserved rather than destroyed.
  const initDone = useRef(false);

  useEffect(() => {
    if (!canvasElRef.current || initDone.current) return;
    initDone.current = true;
    const fc = new Canvas(canvasElRef.current, {
      width: fullW,
      height: fullH,
      backgroundColor: bg,
      preserveObjectStacking: true,
    });
    fcRef.current = fc;
    const sync = () => {
      const obj = fc.getActiveObject();
      setHasSelection(!!obj);
      setSelIsImage(obj?.type === "image");
    };
    fc.on("selection:created", sync);
    fc.on("selection:updated", sync);
    fc.on("selection:cleared", sync);
    return () => {
      fc.dispose();
      fcRef.current = null;
      initDone.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resize the canvas when dimensions change — reposition + rescale objects so
  // they maintain their relative layout (e.g. switching Desktop ↔ Mobile).
  const prevDims = useRef<{ w: number; h: number }>({ w: fullW, h: fullH });
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc) return;
    const prev = prevDims.current;
    const scaleX = fullW / prev.w;
    const scaleY = fullH / prev.h;
    if (Math.abs(scaleX - 1) > 0.001 || Math.abs(scaleY - 1) > 0.001) {
      fc.getObjects().forEach((obj) => {
        obj.set({
          left: (obj.left ?? 0) * scaleX,
          top: (obj.top ?? 0) * scaleY,
          scaleX: (obj.scaleX ?? 1) * scaleX,
          scaleY: (obj.scaleY ?? 1) * scaleY,
        });
        obj.setCoords();
      });
    }
    prevDims.current = { w: fullW, h: fullH };
    fc.setDimensions({ width: fullW, height: fullH });
    fc.renderAll();
  }, [fullW, fullH]);

  // Apply background + shape clip whenever they change. The clip is the OUTER
  // (trim + bleed) shape so artwork fills the bleed but is still trimmed to the
  // sticker's silhouette (rounded/elliptical) rather than spilling to corners.
  useEffect(() => {
    const fc = fcRef.current;
    if (!fc) return;
    fc.backgroundColor = bg;
    if (shape.kind === "ellipse") {
      fc.clipPath = new Ellipse({
        rx: fullW / 2,
        ry: fullH / 2,
        originX: "center",
        originY: "center",
        left: fullW / 2,
        top: fullH / 2,
        absolutePositioned: true,
      });
    } else if (radiusPx + bleed > 0.5) {
      fc.clipPath = new Rect({
        width: fullW,
        height: fullH,
        rx: radiusPx + bleed,
        ry: radiusPx + bleed,
        originX: "center",
        originY: "center",
        left: fullW / 2,
        top: fullH / 2,
        absolutePositioned: true,
      });
    } else {
      fc.clipPath = undefined;
    }
    fc.renderAll();
  }, [bg, shape.kind, fullW, fullH, radiusPx, bleed]);

  // ---- Tools -------------------------------------------------------------
  const addText = () => {
    const fc = fcRef.current;
    if (!fc) return;
    const t = new Textbox("Your text", {
      left: fullW / 2,
      top: fullH / 2,
      originX: "center",
      originY: "center",
      fontSize: Math.round(fullH / 8),
      fill: "#111827",
      fontFamily: FONTS[0],
      textAlign: "center",
      width: fullW * 0.7,
    });
    fc.add(t);
    fc.setActiveObject(t);
    fc.renderAll();
    setHasSelection(true);
  };

  const onImageFile = async (file: File | undefined) => {
    const fc = fcRef.current;
    if (!fc || !file || !file.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    try {
      const img = await FabricImage.fromURL(url, { crossOrigin: "anonymous" });
      const maxDim = Math.min(fullW, fullH) * 0.6;
      const scale = Math.min(maxDim / (img.width || 1), maxDim / (img.height || 1), 1);
      img.set({
        left: fullW / 2,
        top: fullH / 2,
        originX: "center",
        originY: "center",
        scaleX: scale,
        scaleY: scale,
      });
      fileMapRef.current.set(img, file);
      fc.add(img);
      fc.setActiveObject(img);
      fc.renderAll();
      setHasSelection(true);
      setSelIsImage(true);
    } finally {
      URL.revokeObjectURL(url);
    }
  };

  const removeBackground = async () => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (!fc || !obj || obj.type !== "image") return;
    setBgBusy(true);
    setErr(null);
    try {
      let file = fileMapRef.current.get(obj);
      if (!file) {
        // Fall back to the object's current source (e.g. an already-processed image).
        const src = (obj as FabricImage).getSrc();
        const blob = await (await fetch(src)).blob();
        file = new File([blob], "image.png", { type: blob.type || "image/png" });
      }
      const res = await client.removeBg(file);
      await (obj as FabricImage).setSrc(res.image_url, { crossOrigin: "anonymous" });
      fileMapRef.current.delete(obj);
      fc.renderAll();
    } catch (e) {
      setErr(e instanceof WidgetApiError ? e.detail : "Couldn't remove the background.");
    } finally {
      setBgBusy(false);
    }
  };

  const removeSelected = () => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj) {
      fc.remove(obj);
      fc.discardActiveObject();
      fc.renderAll();
      setHasSelection(false);
    }
  };

  const bringForward = () => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj) {
      fc.bringObjectForward(obj);
      fc.renderAll();
    }
  };
  const sendBackward = () => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj) {
      fc.sendObjectBackwards(obj);
      fc.renderAll();
    }
  };

  const activeTextProp = (prop: "fontWeight" | "fontStyle", on: string, off: string) => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj && obj.type === "textbox") {
      const cur = (obj as Textbox).get(prop);
      (obj as Textbox).set(prop, cur === on ? off : on);
      fc.renderAll();
    }
  };
  const setTextFill = (color: string) => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj && obj.type === "textbox") {
      (obj as Textbox).set("fill", color);
      fc.renderAll();
    }
  };
  const setTextFont = (font: string) => {
    const fc = fcRef.current;
    const obj = fc?.getActiveObject();
    if (fc && obj && obj.type === "textbox") {
      (obj as Textbox).set("fontFamily", font);
      fc.renderAll();
    }
  };

  // ---- Live price --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      setPricing(true);
      setErr(null);
      client
        .estimate({
          width_mm: clampMm(widthMm),
          height_mm: clampMm(heightMm),
          quantity,
          cut_style: effectiveStyle,
          vinyl,
          finish,
          corner_radius: isEllipse ? 0 : cornerRadius,
        })
        .then((e) => !cancelled && setEstimate(e))
        .catch((e: unknown) => {
          if (!cancelled) setErr(e instanceof WidgetApiError ? e.detail : "Could not price this.");
        })
        .finally(() => !cancelled && setPricing(false));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [client, widthMm, heightMm, quantity, effectiveStyle, vinyl, finish, clampMm, cornerRadius, isEllipse]);

  // ---- Finalize ----------------------------------------------------------
  const addToCart = async () => {
    const fc = fcRef.current;
    if (!fc || !estimate) return;
    setBusy(true);
    setErr(null);
    try {
      fc.discardActiveObject();
      fc.renderAll();
      // Export the FULL artboard (trim + bleed) at print resolution so the
      // bleed is baked into the PNG; the backend insets the cut line by the
      // bleed and stores the asset at the full size.
      const totalWmm = clampMm(widthMm) + 2 * config.bleed_mm;
      const targetWpx = Math.round((totalWmm / MM_PER_INCH) * PRINT_DPI);
      const multiplier = targetWpx / fullW;
      const dataUrl = fc.toDataURL({ format: "png", multiplier, enableRetinaScaling: false });
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], "design.png", { type: "image/png" });

      const fin = await client.canvasFinalize({
        printImage: file,
        quoteToken: estimate.quote_token,
        shape: shape.kind,
        name: config.name,
      });
      window.parent?.postMessage(
        {
          type: "printlay:add-to-cart",
          design_ref: fin.design_ref,
          quote_token: fin.quote_token,
          total: fin.total,
          currency: fin.currency,
          quantity,
          options: fin.options,
        },
        "*"
      );
      onDone();
    } catch (e) {
      setErr(e instanceof WidgetApiError ? e.detail : "Could not add to cart.");
    } finally {
      setBusy(false);
    }
  };

  const money = (n: number) => `${currencySymbol(config.currency)}${n.toFixed(2)}`;

  // ---- Sub-renders -------------------------------------------------------
  const toolbar = (
    <div className="psw-toolbar">
      <button className="psw-tool" onClick={addText} title="Add text">
        <TypeIcon size={16} /> Text
      </button>
      <button className="psw-tool" onClick={() => imgInputRef.current?.click()} title="Add image">
        <ImagePlus size={16} /> Image
      </button>
      <span className="psw-tool-sep" />
      <button className="psw-tool" disabled={!hasSelection} onClick={() => activeTextProp("fontWeight", "bold", "normal")}>
        <Bold size={16} />
      </button>
      <button className="psw-tool" disabled={!hasSelection} onClick={() => activeTextProp("fontStyle", "italic", "normal")}>
        <Italic size={16} />
      </button>
      <button
        className="psw-tool"
        disabled={!selIsImage || bgBusy}
        onClick={removeBackground}
        title="Remove background from selected image"
      >
        <Eraser size={16} /> {bgBusy ? "Removing…" : "Remove BG"}
      </button>
      <button className="psw-tool" disabled={!hasSelection} onClick={bringForward} title="Bring forward">
        <ArrowUp size={16} />
      </button>
      <button className="psw-tool" disabled={!hasSelection} onClick={sendBackward} title="Send backward">
        <ArrowDown size={16} />
      </button>
      <button className="psw-tool psw-tool-danger" disabled={!hasSelection} onClick={removeSelected} title="Delete">
        <Trash2 size={16} />
      </button>
      <input
        ref={imgInputRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => onImageFile(e.target.files?.[0])}
      />
    </div>
  );

  const stage = (
    <div className="psw-stage">
      <div className="psw-board-wrap" style={{ width: fullW, height: fullH }}>
        {/* The artboard now spans the FULL trim + bleed area, so backgrounds and
            artwork run all the way to the bleed edge. */}
        <div
          className="psw-artboard"
          style={{
            width: fullW,
            height: fullH,
            borderRadius: isEllipse ? "50%" : radiusPx + bleed,
          }}
        >
          <canvas ref={canvasElRef} />
        </div>
        {/* Bleed edge — artwork should run all the way to here */}
        <div
          className="psw-guide psw-guide-bleed"
          style={{
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            borderRadius: isEllipse ? "50%" : radiusPx + bleed,
          }}
        />
        {/* Cut line = the actual sticker edge, inset by the bleed */}
        <div
          className="psw-guide psw-guide-cut"
          style={{
            top: bleed,
            bottom: bleed,
            left: bleed,
            right: bleed,
            borderRadius: isEllipse ? "50%" : radiusPx,
          }}
        />
        {/* Safe area — keep text & key art inside this */}
        <div
          className="psw-guide psw-guide-safe"
          style={{
            top: bleed + safe,
            bottom: bleed + safe,
            left: bleed + safe,
            right: bleed + safe,
            borderRadius: isEllipse ? "50%" : Math.max(0, radiusPx - safe),
          }}
        />
      </div>
    </div>
  );

  const legend = (
    <div className="psw-legend">
      <span>
        <i className="psw-dot psw-dot-bleed" /> Bleed · fill to here ({config.bleed_mm}mm)
      </span>
      <span>
        <i className="psw-dot psw-dot-cut" /> Cut line (sticker edge)
      </span>
      <span>
        <i className="psw-dot psw-dot-safe" /> Safe area · {config.safe_mm}mm in
      </span>
    </div>
  );

  const designControls = (
    <>
      {hasSelection && (
        <div className="psw-field">
          <label className="psw-label">Selected text</label>
          <div className="psw-swatches">
            {PALETTE.map((c) => (
              <button
                key={c}
                className="psw-swatch"
                style={{ background: c }}
                onClick={() => setTextFill(c)}
                title={`Text colour ${c}`}
              />
            ))}
          </div>
          <select className="psw-select-sm" onChange={(e) => setTextFont(e.target.value)}>
            {FONTS.map((f) => (
              <option key={f} value={f}>
                {f.split(",")[0]}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="psw-field">
        <label className="psw-label">Background</label>
        <div className="psw-swatches">
          {PALETTE.map((c) => (
            <button
              key={c}
              className={`psw-swatch ${bg === c ? "is-active" : ""}`}
              style={{ background: c }}
              onClick={() => setBg(c)}
              title={c}
            />
          ))}
        </div>
      </div>
    </>
  );

  const options = (
    <>
      {safeStyles.length > 1 && (
        <div className="psw-field">
          <label className="psw-label">Shape</label>
          <div className="psw-chips">
            {safeStyles.map((s) => (
              <button
                key={s}
                className={`psw-chip ${style === s ? "is-active" : ""}`}
                onClick={() => setStyle(s)}
              >
                {shapeFor(s).label}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="psw-unit-row">
        <span className="psw-label" style={{ margin: 0 }}>Units</span>
        <div className="psw-unit">
          {(["cm", "mm"] as SizeUnit[]).map((u) => (
            <button
              key={u}
              type="button"
              className={unit === u ? "is-active" : ""}
              onClick={() => setUnit(u)}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      {presets.length > 0 && (
        <div className="psw-field">
          <label className="psw-label">Size</label>
          <div className="psw-chips">
            {presets.map((p, i) => (
              <button
                key={i}
                className={`psw-chip ${sizeSel === i ? "is-active" : ""}`}
                onClick={() => selectPreset(i)}
              >
                {p.width_mm === p.height_mm
                  ? fmtLen(p.width_mm, unit)
                  : `${mmToUnit(p.width_mm, unit)}×${fmtLen(p.height_mm, unit)}`}
              </button>
            ))}
            {allowCustom && (
              <button
                className={`psw-chip ${sizeSel === -1 ? "is-active" : ""}`}
                onClick={selectCustom}
              >
                Custom
              </button>
            )}
          </div>
        </div>
      )}

      {(presets.length === 0 || sizeSel === -1) && (
        <>
          <div className="psw-field">
            <div className="psw-label-row">
              <label className="psw-label">Width ({unit})</label>
              <span className="psw-dim">
                {mmToUnit(config.min_size_mm, unit)}–{mmToUnit(config.max_size_mm, unit)}
              </span>
            </div>
            <NumField
              value={mmToUnit(widthMm, unit)}
              min={mmToUnit(config.min_size_mm, unit)}
              max={mmToUnit(config.max_size_mm, unit)}
              onCommit={(v) => setWidthMm(Math.round(unitToMm(v, unit)))}
              ariaLabel={`Width in ${unit}`}
              decimals={dec}
            />
          </div>

          {canUnlock && (
            <label className="psw-toggle">
              <input
                type="checkbox"
                checked={unlocked}
                onChange={(e) => setUnlocked(e.target.checked)}
              />
              <span>Custom height — make {style === "circle" ? "an oval" : "a rectangle"}</span>
            </label>
          )}

          {!shape.lock && (
            <div className="psw-field">
              <div className="psw-label-row">
                <label className="psw-label">Height ({unit})</label>
                <span className="psw-dim">
                  {mmToUnit(config.min_size_mm, unit)}–{mmToUnit(config.max_size_mm, unit)}
                </span>
              </div>
              <NumField
                value={mmToUnit(heightMm, unit)}
                min={mmToUnit(config.min_size_mm, unit)}
                max={mmToUnit(config.max_size_mm, unit)}
                onCommit={(v) => setHeightMm(Math.round(unitToMm(v, unit)))}
                ariaLabel={`Height in ${unit}`}
                decimals={dec}
              />
            </div>
          )}
        </>
      )}

      {!isEllipse && (
        <div className="psw-field">
          <div className="psw-label-row">
            <label className="psw-label">Corner radius</label>
            <span className="psw-dim">{Math.round(cornerRadius * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={cornerRadius}
            onChange={(e) => setCornerRadius(parseFloat(e.target.value))}
            aria-label="Corner radius"
          />
        </div>
      )}

      {config.vinyl_types.length > 0 && (
        <div className="psw-field">
          <label className="psw-label">Material</label>
          <select value={vinyl ?? ""} onChange={(e) => setVinyl(e.target.value)}>
            {config.vinyl_types.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {config.finishes.length > 0 && (
        <div className="psw-field">
          <label className="psw-label">Finish</label>
          <select value={finish ?? ""} onChange={(e) => setFinish(e.target.value)}>
            {config.finishes.map((v) => (
              <option key={v.key} value={v.key}>
                {v.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="psw-field">
        <label className="psw-label">Quantity</label>
        <NumField value={quantity} min={1} max={100000} onCommit={setQuantity} ariaLabel="Quantity" />
      </div>

      <div className="psw-price">
        {err ? (
          <div className="psw-err">{err}</div>
        ) : estimate ? (
          <>
            <div className="psw-price-total">{money(estimate.breakdown.total)}</div>
            <div className="psw-price-unit">
              {money(estimate.breakdown.unit_price)} each · {estimate.breakdown.quantity} stickers
              {estimate.breakdown.quantity_discount_pct > 0 &&
                ` · ${estimate.breakdown.quantity_discount_pct}% off`}
            </div>
          </>
        ) : (
          <div className="psw-price-unit">{pricing ? "Pricing…" : "—"}</div>
        )}
      </div>

      <button className="psw-btn-primary" disabled={!estimate || busy || pricing} onClick={addToCart}>
        {busy ? "Adding…" : "Add to cart"}
      </button>
    </>
  );

  return (
    <div className={`psw-shaped psw-shaped--${viewMode}`}>
      <div className="psw-shaped-bar">
        <span className="psw-shaped-title">{config.name}</span>
        <div className="psw-viewtoggle" role="group" aria-label="Preview layout">
          <button
            className={`psw-viewbtn ${viewMode === "desktop" ? "is-active" : ""}`}
            onClick={() => setViewMode("desktop")}
            title="Desktop layout"
          >
            <Monitor size={15} /> Desktop
          </button>
          <button
            className={`psw-viewbtn ${viewMode === "mobile" ? "is-active" : ""}`}
            onClick={() => setViewMode("mobile")}
            title="Mobile layout"
          >
            <Smartphone size={15} /> Mobile
          </button>
        </div>
      </div>

      <div className="psw-shaped-body">
        <div className="psw-shaped-main">
          {toolbar}
          {stage}
          {legend}
          <div className="psw-shaped-designctl">{designControls}</div>
        </div>
        <div className="psw-shaped-side">{options}</div>
      </div>
    </div>
  );
}

function currencySymbol(code: string): string {
  const map: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", AUD: "$", CAD: "$" };
  return map[code] || `${code} `;
}
