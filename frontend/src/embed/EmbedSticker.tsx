import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FILTER_PRESETS } from "../components/app/filterPresets";
import { SizeUnit, fmtLen, fmtPair } from "../utils/units";
import ShapedDesigner from "./ShapedDesigner";
import {
  ProcessResult,
  ProductConfig,
  WidgetApiError,
  WidgetClient,
  EstimateResult,
  tokenFromUrl,
} from "./widgetClient";

const CUT_STYLE_LABELS: Record<string, string> = {
  square: "Square",
  circle: "Circle",
  cut_around: "Cut Around Image",
  bg_removal: "Background Removal",
  face: "Face Sticker",
  // Legacy keys
  die_cut: "Background Removal",
  keep_bg: "Square",
};

type Step = "loading" | "error" | "upload" | "design" | "done";

/**
 * Standalone embeddable sticker builder. Served at /embed/sticker?token=...,
 * with NO app shell or auth guards — it authenticates purely with the widget
 * session token and posts the finished design back to the host store via
 * `postMessage`.
 */
export default function EmbedSticker() {
  const token = useMemo(() => tokenFromUrl(), []);
  const client = useMemo(() => (token ? new WidgetClient(token) : null), [token]);

  const [step, setStep] = useState<Step>("loading");
  const [fatal, setFatal] = useState<string | null>(null);
  const [config, setConfig] = useState<ProductConfig | null>(null);

  useEffect(() => {
    if (!client) {
      setFatal("This sticker designer link is missing its session. Please reopen it from the product page.");
      setStep("error");
      return;
    }
    client
      .config()
      .then((c) => {
        setConfig(c);
        setStep("upload");
      })
      .catch((e: unknown) => {
        setFatal(e instanceof WidgetApiError ? e.detail : "Could not start the designer.");
        setStep("error");
      });
  }, [client]);

  if (step === "loading") return <Centered>Loading designer…</Centered>;
  if (step === "error" || !client || !config)
    return <Centered tone="error">{fatal || "Something went wrong."}</Centered>;

  // Canvas (shaped) products get the full multi-layer designer; cut-out
  // products get the single-artwork + background-removal flow.
  if (config.designer === "canvas") {
    return (
      <div className="psw-root">
        <StyleTag />
        {step === "done" ? (
          <DoneStep />
        ) : (
          <ShapedDesigner config={config} client={client} onDone={() => setStep("done")} />
        )}
        <PoweredBy />
      </div>
    );
  }

  return (
    <div className="psw-root">
      <StyleTag />
      {step === "upload" && (
        <UploadStep
          config={config}
          client={client}
          onProcessed={() => setStep("design")}
        />
      )}
      {step === "design" && (
        <DesignStep config={config} client={client} onDone={() => setStep("done")} />
      )}
      {step === "done" && <DoneStep />}
      <PoweredBy />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Upload
// --------------------------------------------------------------------------- //
function UploadStep({
  config,
  client,
  onProcessed,
}: {
  config: ProductConfig;
  client: WidgetClient;
  onProcessed: (r: ProcessResult) => void;
}) {
  const styles = config.enabled_cut_styles.length
    ? config.enabled_cut_styles
    : ["bg_removal"];
  const [cutStyle, setCutStyle] = useState(styles[0]);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined) => {
    if (!f || !f.type.startsWith("image/")) return;
    setFile(f);
    setPreviewUrl(URL.createObjectURL(f));
    setErr(null);
  };

  const create = async () => {
    if (!file) return;
    // For Square/Circle: store file and go straight to design step
    if (cutStyle === "square" || cutStyle === "circle") {
      sessionStore.file = file;
      sessionStore.cutStyle = cutStyle;
      onProcessed(null as any);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await client.process(file, cutStyle);
      sessionStore.result = r;
      sessionStore.cutStyle = cutStyle;
      onProcessed(r);
    } catch (e) {
      setErr(e instanceof WidgetApiError ? e.detail : "Processing failed. Try another image.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="psw-card">
      <h1 className="psw-h1">{config.name}</h1>
      <p className="psw-sub">Upload your artwork and we'll turn it into a print-ready sticker.</p>

      <div
        className="psw-drop"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          pick(e.dataTransfer.files[0]);
        }}
      >
        {previewUrl ? (
          <img src={previewUrl} alt="Your artwork" className="psw-drop-img" />
        ) : (
          <div className="psw-drop-empty">
            <strong>Click to upload</strong> or drag an image here
            <span>PNG, JPG up to 25&nbsp;MB</span>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => pick(e.target.files?.[0])}
        />
      </div>

      {styles.length > 1 && (
        <div className="psw-field">
          <label className="psw-label">Cut style</label>
          <div className="psw-chips">
            {styles.map((s) => (
              <button
                key={s}
                type="button"
                className={`psw-chip ${cutStyle === s ? "is-active" : ""}`}
                onClick={() => setCutStyle(s)}
              >
                {CUT_STYLE_LABELS[s] || s}
              </button>
            ))}
          </div>
        </div>
      )}

      {err && <div className="psw-err">{err}</div>}

      <button className="psw-btn-primary" disabled={!file || busy} onClick={create}>
        {busy ? "Creating design…" : "Create design"}
      </button>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Design + options + live price
// --------------------------------------------------------------------------- //
const sessionStore: { result: ProcessResult | null; cutStyle: string; file: File | null } = {
  result: null,
  cutStyle: "bg_removal",
  file: null,
};

function DesignStep({
  config,
  client,
  onDone,
}: {
  config: ProductConfig;
  client: WidgetClient;
  onDone: () => void;
}) {
  const [result, setResult] = useState<ProcessResult | null>(sessionStore.result);
  const [cutStyle, setCutStyle] = useState(sessionStore.cutStyle);
  const [filterId, setFilterId] = useState("none");
  const [tighten, setTighten] = useState(0);
  const [tightenLocal, setTightenLocal] = useState(0);
  const CORNER_MIN = 0.01;
  const [cornerRadius, setCornerRadius] = useState(CORNER_MIN);
  const [busy, setBusy] = useState(false);
  const [aiStyling, setAiStyling] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState("");
  const [editingCutline, setEditingCutline] = useState(false);

  // --- Canvas state for square/circle (image positioning) ---
  const isCanvasStyle = cutStyle === "square" || cutStyle === "circle";
  const canvasShape = cutStyle === "circle" ? "circle" : "rectangle";
  const file = sessionStore.file;
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [naturalW, setNaturalW] = useState(1);
  const [naturalH, setNaturalH] = useState(1);
  const bleedDefault = config.bleed_mm ?? 3.0;
  const [canvasBleed, setCanvasBleed] = useState(bleedDefault);
  const [canvasCornerRadius, setCanvasCornerRadius] = useState(3.0);
  const [imgX, setImgX] = useState(0);
  const [imgY, setImgY] = useState(0);
  const [imgW, setImgW] = useState(100);
  const [imgH, setImgH] = useState(100);
  const [canvasDragging, setCanvasDragging] = useState(false);
  const [canvasDragStart, setCanvasDragStart] = useState<{ x: number; y: number; ix: number; iy: number } | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement>(null);
  const [loadedImg, setLoadedImg] = useState<HTMLImageElement | null>(null);
  const [canvasProcessed, setCanvasProcessed] = useState(false);

  // Load image for canvas styles
  useEffect(() => {
    if (!isCanvasStyle || !file) return;
    const url = URL.createObjectURL(file);
    setImgUrl(url);
    const img = new Image();
    img.onload = () => {
      setNaturalW(img.width);
      setNaturalH(img.height);
      const aspect = img.width / img.height;
      const canW = 100;
      const canH = 100;
      if (aspect > 1) {
        setImgW(canW);
        setImgH(canW / aspect);
        setImgX(0);
        setImgY((canH - canW / aspect) / 2);
      } else {
        setImgH(canH);
        setImgW(canH * aspect);
        setImgX((canW - canH * aspect) / 2);
        setImgY(0);
      }
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCanvasStyle, file]);

  useEffect(() => {
    if (!imgUrl) return;
    const im = new Image();
    im.onload = () => setLoadedImg(im);
    im.src = imgUrl;
  }, [imgUrl]);

  // Natural aspect of the processed design; the customer scales by longest side.
  const aspect = result && result.height_mm > 0 ? result.width_mm / result.height_mm : 1;
  const clamp = (v: number) => Math.min(config.max_size_mm, Math.max(config.min_size_mm, v));
  const naturalLongest = result ? Math.max(result.width_mm, result.height_mm) : config.min_size_mm;

  // Fixed sizes the merchant pre-programmed. For cut-out stickers a preset just
  // sets the longest side (the artwork's aspect ratio is preserved).
  const presets = useMemo(
    () =>
      (config.size_presets ?? [])
        .map((p) => Math.round(Math.max(p.width_mm, p.height_mm)))
        .filter((v) => v > 0),
    [config.size_presets]
  );
  const allowCustom = config.allow_custom_size !== false || presets.length === 0;
  // -1 = custom (slider); >=0 = index into presets.
  const [sizeSel, setSizeSel] = useState<number>(presets.length ? 0 : -1);
  // Width in mm (slider controls this directly); height derived from aspect.
  const [widthMm, setWidthMm] = useState(() => {
    const raw = clamp(presets.length ? presets[0] : naturalLongest);
    return Math.round(raw / 5) * 5 || 5;
  });
  // For canvas styles, height is independent (square stickers can be non-square)
  const [heightMm, setHeightMm] = useState(() => {
    const raw = clamp(presets.length ? presets[0] : 100);
    return Math.round(raw / 5) * 5 || 5;
  });

  // Canvas rendering for square/circle preview
  const canvasTotalW = widthMm + 2 * canvasBleed;
  const canvasTotalH = heightMm + 2 * canvasBleed;
  const canvasDisplayPx = 280;
  const canvasScale = canvasDisplayPx / Math.max(canvasTotalW, canvasTotalH);
  const cDW = canvasTotalW * canvasScale;
  const cDH = canvasTotalH * canvasScale;

  useEffect(() => {
    if (!isCanvasStyle || naturalW <= 1) return;
    const ratio = naturalW / naturalH;
    if (ratio > 1) {
      setImgW(widthMm);
      setImgH(widthMm / ratio);
      setImgX(0);
      setImgY((heightMm - widthMm / ratio) / 2);
    } else {
      setImgH(heightMm);
      setImgW(heightMm * ratio);
      setImgX((widthMm - heightMm * ratio) / 2);
      setImgY(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthMm, heightMm]);

  useEffect(() => {
    if (!isCanvasStyle) return;
    const c = canvasElRef.current;
    if (!c || !loadedImg) return;
    c.width = cDW * 2;
    c.height = cDH * 2;
    c.style.width = `${cDW}px`;
    c.style.height = `${cDH}px`;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(2, 2);

    const r = canvasCornerRadius * canvasScale;

    const roundedPath = (x: number, y: number, w: number, h: number, radius: number) => {
      const rr = Math.min(radius, w / 2, h / 2);
      ctx.beginPath();
      ctx.moveTo(x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.arcTo(x + w, y, x + w, y + rr, rr);
      ctx.lineTo(x + w, y + h - rr);
      ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
      ctx.lineTo(x + rr, y + h);
      ctx.arcTo(x, y + h, x, y + h - rr, rr);
      ctx.lineTo(x, y + rr);
      ctx.arcTo(x, y, x + rr, y, rr);
      ctx.closePath();
    };

    ctx.fillStyle = "#e5e7eb";
    ctx.fillRect(0, 0, cDW, cDH);

    const sx = canvasBleed * canvasScale;
    const sy = canvasBleed * canvasScale;
    const sw = widthMm * canvasScale;
    const sh = heightMm * canvasScale;

    ctx.fillStyle = "#ffffff";
    if (canvasShape === "circle") {
      ctx.beginPath();
      ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      roundedPath(sx, sy, sw, sh, r);
      ctx.fill();
    }

    const ix = (canvasBleed + imgX) * canvasScale;
    const iy = (canvasBleed + imgY) * canvasScale;
    const iw = imgW * canvasScale;
    const ih = imgH * canvasScale;
    ctx.drawImage(loadedImg, ix, iy, iw, ih);

    // Bleed overlay (semi-transparent outside cut area)
    ctx.fillStyle = "rgba(229, 231, 235, 0.45)";
    ctx.beginPath();
    ctx.rect(0, 0, cDW, cDH);
    if (canvasShape === "circle") {
      ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
    } else {
      roundedPath(sx, sy, sw, sh, r);
    }
    ctx.fill("evenodd");

    // Blue dashed cut line
    ctx.strokeStyle = "#2684ff";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    if (canvasShape === "circle") {
      ctx.beginPath();
      ctx.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      roundedPath(sx, sy, sw, sh, r);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }, [isCanvasStyle, loadedImg, widthMm, heightMm, imgX, imgY, imgW, imgH, canvasBleed, canvasScale, canvasShape, canvasCornerRadius, cDW, cDH]);

  const canvasCenterH = () => setImgX((widthMm - imgW) / 2);
  const canvasCenterV = () => setImgY((heightMm - imgH) / 2);
  const canvasCenterBoth = () => { setImgX((widthMm - imgW) / 2); setImgY((heightMm - imgH) / 2); };
  const canvasScaleUp = () => {
    const ratio = naturalW / naturalH;
    const newW = imgW * 1.1;
    const newH = newW / ratio;
    setImgX(imgX - (newW - imgW) / 2);
    setImgY(imgY - (newH - imgH) / 2);
    setImgW(newW);
    setImgH(newH);
  };
  const canvasScaleDown = () => {
    const ratio = naturalW / naturalH;
    const newW = Math.max(10, imgW * 0.9);
    const newH = newW / ratio;
    setImgX(imgX - (newW - imgW) / 2);
    setImgY(imgY - (newH - imgH) / 2);
    setImgW(newW);
    setImgH(newH);
  };
  const onCanvasMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setCanvasDragging(true);
    setCanvasDragStart({ x: e.clientX, y: e.clientY, ix: imgX, iy: imgY });
  };
  const onCanvasMouseMove = (e: React.MouseEvent) => {
    if (!canvasDragging || !canvasDragStart) return;
    setImgX(canvasDragStart.ix + (e.clientX - canvasDragStart.x) / canvasScale);
    setImgY(canvasDragStart.iy + (e.clientY - canvasDragStart.y) / canvasScale);
  };
  const onCanvasMouseUp = () => setCanvasDragging(false);
  const onCanvasTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    setCanvasDragging(true);
    setCanvasDragStart({ x: t.clientX, y: t.clientY, ix: imgX, iy: imgY });
  };
  const onCanvasTouchMove = (e: React.TouchEvent) => {
    if (!canvasDragging || !canvasDragStart) return;
    const t = e.touches[0];
    setImgX(canvasDragStart.ix + (t.clientX - canvasDragStart.x) / canvasScale);
    setImgY(canvasDragStart.iy + (t.clientY - canvasDragStart.y) / canvasScale);
  };

  const processCanvasDesign = async () => {
    if (!file) return;
    setBusy(true);
    setPriceErr(null);
    try {
      const r = await client.processCanvas(file, {
        canvasWidthMm: widthMm,
        canvasHeightMm: heightMm,
        imgXMm: imgX,
        imgYMm: imgY,
        imgWidthMm: imgW,
        imgHeightMm: imgH,
        cornerRadiusMm: canvasCornerRadius,
        bleedMm: canvasBleed,
        shape: canvasShape as "rectangle" | "circle",
      });
      sessionStore.result = r;
      setResult(r);
      setCanvasProcessed(true);
      return r;
    } catch (e) {
      setPriceErr(e instanceof WidgetApiError ? e.detail : "Processing failed.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const [vinyl, setVinyl] = useState<string | null>(config.vinyl_types[0]?.key ?? null);
  const [finish, setFinish] = useState<string | null>(config.extras_required ? (config.finishes[0]?.key ?? null) : null);
  const [quantity, setQuantity] = useState(() => {
    const presets = config.quantity_presets ?? [];
    return presets.length > 0 ? presets[0] : 50;
  });
  const [customQty, setCustomQty] = useState(false);
  const [batchPrices, setBatchPrices] = useState<{ quantity: number; unit_price: number; total: number }[]>([]);
  const [unit, setUnit] = useState<SizeUnit>("cm");

  // Proof system state
  const [proofChoice, setProofChoice] = useState<"approve" | "manual">("approve");
  const [proofNote, setProofNote] = useState("");
  const [customerEmail, setCustomerEmail] = useState("");

  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [pricing, setPricing] = useState(false);
  const [priceErr, setPriceErr] = useState<string | null>(null);

  // Derive height from width using aspect ratio (width / height).
  const dims = useMemo(() => {
    if (isCanvasStyle) {
      return { width_mm: clamp(widthMm), height_mm: clamp(heightMm) };
    }
    const w = clamp(widthMm);
    const h = clamp(Math.round(w / aspect));
    return { width_mm: w, height_mm: h };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widthMm, heightMm, aspect, config.min_size_mm, config.max_size_mm, isCanvasStyle]);

  const regen = useCallback(
    async (next: {
      cutStyle?: string;
      tighten?: number;
      filterId?: string;
      cornerRadius?: number;
    }) => {
      const cs = next.cutStyle ?? cutStyle;
      const t = next.tighten ?? tighten;
      const fid = next.filterId ?? filterId;
      const cr = next.cornerRadius ?? cornerRadius;
      setBusy(true);
      try {
        const r = await client.regenerate(cs, t, fid, cr);
        setResult(r);
        sessionStore.result = r;
        sessionStore.cutStyle = cs;
        setCutStyle(cs);
        setTighten(t);
        setFilterId(fid);
        setCornerRadius(cr);
      } catch {
        /* keep previous preview on failure */
      } finally {
        setBusy(false);
      }
    },
    [client, cutStyle, tighten, filterId, cornerRadius]
  );

  const handleAiStyle = useCallback(
    async (style: string, prompt?: string) => {
      setAiStyling(style);
      setBusy(true);
      try {
        const r = await client.aiStyle(style, prompt);
        setResult(r);
        sessionStore.result = r;
        setFilterId("none");
      } catch (e: any) {
        const msg = e instanceof WidgetApiError ? e.detail : (e?.message || "AI style failed. Please try again.");
        setPriceErr(msg);
      } finally {
        setAiStyling(null);
        setBusy(false);
      }
    },
    [client]
  );

  // Debounced live price whenever the order options change.
  useEffect(() => {
    let cancelled = false;
    const id = setTimeout(() => {
      setPricing(true);
      setPriceErr(null);
      client
        .estimate({
          width_mm: dims.width_mm,
          height_mm: dims.height_mm,
          quantity,
          cut_style: cutStyle,
          vinyl,
          finish,
        })
        .then((e) => {
          if (!cancelled) setEstimate(e);
        })
        .catch((e: unknown) => {
          if (!cancelled)
            setPriceErr(e instanceof WidgetApiError ? e.detail : "Could not price this.");
        })
        .finally(() => {
          if (!cancelled) setPricing(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [client, dims.width_mm, dims.height_mm, quantity, cutStyle, vinyl, finish]);

  // Batch-fetch unit prices for all quantity presets (for radio labels).
  useEffect(() => {
    const presets = config.quantity_presets ?? [];
    if (presets.length === 0 || dims.width_mm <= 0 || dims.height_mm <= 0) return;
    let cancelled = false;
    const id = setTimeout(() => {
      client
        .estimateBatch({
          width_mm: dims.width_mm,
          height_mm: dims.height_mm,
          quantities: presets,
          cut_style: cutStyle,
          vinyl: vinyl ?? undefined,
          finish: finish ?? undefined,
        })
        .then((r) => { if (!cancelled) setBatchPrices(r); })
        .catch(() => { if (!cancelled) setBatchPrices([]); });
    }, 400);
    return () => { cancelled = true; clearTimeout(id); };
  }, [client, config.quantity_presets, dims.width_mm, dims.height_mm, cutStyle, vinyl, finish]);

  const addToCart = async () => {
    if (!estimate) return;
    setBusy(true);
    try {
      // For canvas styles, process the image first if not yet done
      if (isCanvasStyle && !canvasProcessed) {
        const r = await processCanvasDesign();
        if (!r) { setBusy(false); return; }
      }
      const proofInfo = config.require_proof && proofChoice === "manual"
        ? { proof_requested: true, customer_email: customerEmail, proof_note: proofNote }
        : { proof_requested: false };
      const fin = await client.finalize(estimate.quote_token, config.name, proofInfo);
      window.parent?.postMessage(
        {
          type: "printlay:add-to-cart",
          design_ref: fin.design_ref,
          quote_token: fin.quote_token,
          total: fin.total,
          currency: fin.currency,
          quantity,
          options: fin.options,
          thumbnail_url: fin.thumbnail_url,
        },
        "*"
      );
      onDone();
    } catch (e) {
      setPriceErr(e instanceof WidgetApiError ? e.detail : "Could not add to cart.");
    } finally {
      setBusy(false);
    }
  };

  const money = (n: number) => `${currencySymbol(config.currency)}${n.toFixed(2)}`;

  if (editingCutline && result) {
    return (
      <EmbedCutlineEditor
        borderUrl={result.border_url}
        points={result.cutline_points}
        onApply={async (pts) => {
          setBusy(true);
          try {
            const r = await client.editCutline(pts);
            setResult(r);
            sessionStore.result = r;
          } catch { /* keep previous */ }
          setBusy(false);
          setEditingCutline(false);
        }}
        onClose={() => setEditingCutline(false)}
      />
    );
  }

  return (
    <div className="psw-grid">
      <div className="psw-card psw-preview-col">
        {isCanvasStyle ? (
          <>
            <div className="psw-canvas-wrap">
              <p className="psw-hint">Drag the image to position. Blue line = cut line, grey = bleed.</p>
              <canvas
                ref={canvasElRef}
                style={{ width: cDW, height: cDH, cursor: canvasDragging ? "grabbing" : "grab", display: "block", margin: "0 auto", borderRadius: 8 }}
                onMouseDown={onCanvasMouseDown}
                onMouseMove={onCanvasMouseMove}
                onMouseUp={onCanvasMouseUp}
                onMouseLeave={onCanvasMouseUp}
                onTouchStart={onCanvasTouchStart}
                onTouchMove={onCanvasTouchMove}
                onTouchEnd={() => setCanvasDragging(false)}
              />
            </div>
            <div className="psw-field">
              <div className="psw-btn-row" style={{ justifyContent: "center" }}>
                <button className="psw-btn-small" onClick={canvasScaleUp}>+ Scale Up</button>
                <button className="psw-btn-small" onClick={canvasScaleDown}>− Scale Down</button>
                <button className="psw-btn-small" onClick={canvasCenterH}>Center H</button>
                <button className="psw-btn-small" onClick={canvasCenterV}>Center V</button>
                <button className="psw-btn-small psw-btn-active" onClick={canvasCenterBoth}>Center Both</button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className={`psw-preview ${busy ? "is-busy" : ""}`}>
              {result && (
                <CutPreview
                  key={result.border_url}
                  borderUrl={result.border_url}
                  points={result.cutline_points}
                  committedTighten={tighten}
                  liveTighten={tightenLocal}
                  widthMm={result.width_mm}
                  heightMm={result.height_mm}
                  cutStyle={cutStyle}
                  liveCornerRadius={cornerRadius}
                />
              )}
              {busy && <div className="psw-spin" />}
            </div>
          </>
        )}

        {config.show_filters !== false && !isCanvasStyle && (
        <div className="psw-field">
          <label className="psw-label">Filter</label>
          <div className="psw-filmstrip">
            {FILTER_PRESETS.map((f) => (
              <button
                key={f.id}
                type="button"
                className={`psw-film ${filterId === f.id ? "is-active" : ""}`}
                onClick={() => regen({ filterId: f.id })}
                disabled={busy}
              >
                {result && result.border_url && (
                  <img src={result.border_url} alt="" style={{ filter: f.css }} loading="eager" />
                )}
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        </div>
        )}

        {config.show_ai_styles && !isCanvasStyle && (
        <div className="psw-field">
          <label className="psw-label">AI Style</label>
          <div className="psw-ai-styles">
            {[
              { id: "cartoon", label: "Cartoon" },
              { id: "caricature", label: "Caricature" },
              { id: "pencil", label: "Pencil" },
              { id: "anime", label: "Anime" },
              { id: "popart", label: "Pop art" },
              { id: "watercolor", label: "Watercolour" },
            ].map((s) => (
              <button
                key={s.id}
                type="button"
                className={`psw-ai-btn ${aiStyling === s.id ? "is-loading" : ""}`}
                onClick={() => handleAiStyle(s.id)}
                disabled={busy || !!aiStyling}
              >
                {aiStyling === s.id ? "..." : s.label}
              </button>
            ))}
          </div>
          <div className="psw-ai-custom">
            <input
              type="text"
              placeholder="Custom style, e.g. &quot;neon glow&quot;"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              disabled={busy || !!aiStyling}
              className="psw-ai-input"
            />
            <button
              type="button"
              className="psw-ai-btn psw-ai-go"
              disabled={busy || !!aiStyling || !customPrompt.trim()}
              onClick={() => handleAiStyle("custom", customPrompt.trim())}
            >
              {aiStyling === "custom" ? "..." : "Go"}
            </button>
          </div>
        </div>
        )}
      </div>

      <div className="psw-card psw-options-col">
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

        <div className="psw-field">
          <div className="psw-label-row">
            <label className="psw-label">Size (width)</label>
            <span className="psw-dim">{fmtPair(dims.width_mm, dims.height_mm, unit)}</span>
          </div>
          {presets.length > 0 && (
            <div className="psw-chips" style={{ marginBottom: sizeSel === -1 ? 10 : 0 }}>
              {presets.map((mm, i) => (
                <button
                  key={i}
                  type="button"
                  className={`psw-chip ${sizeSel === i ? "is-active" : ""}`}
                  onClick={() => {
                    setSizeSel(i);
                    const val = Math.round(clamp(mm) / 5) * 5;
                    setWidthMm(val);
                    if (isCanvasStyle) setHeightMm(val);
                  }}
                >
                  {fmtLen(mm, unit)}
                </button>
              ))}
              {allowCustom && (
                <button
                  type="button"
                  className={`psw-chip ${sizeSel === -1 ? "is-active" : ""}`}
                  onClick={() => setSizeSel(-1)}
                >
                  Custom
                </button>
              )}
            </div>
          )}
          {sizeSel === -1 && !isCanvasStyle && (
            <input
              type="range"
              min={config.min_size_mm}
              max={config.max_size_mm}
              step={5}
              value={widthMm}
              onChange={(e) => setWidthMm(Math.round(parseInt(e.target.value, 10) / 5) * 5)}
            />
          )}
          {sizeSel === -1 && isCanvasStyle && (
            <div className="psw-dim-row" style={{ marginTop: 6 }}>
              <div className="psw-input-group">
                <span className="psw-input-label">Width ({unit})</span>
                <input type="number" className="psw-num-input"
                  value={unit === "cm" ? Math.round(widthMm / 10 * 10) / 10 : widthMm}
                  min={unit === "cm" ? config.min_size_mm / 10 : config.min_size_mm}
                  max={unit === "cm" ? config.max_size_mm / 10 : config.max_size_mm}
                  step={unit === "cm" ? 0.5 : 5}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setWidthMm(clamp(unit === "cm" ? v * 10 : v));
                  }}
                />
              </div>
              <div className="psw-input-group">
                <span className="psw-input-label">Height ({unit})</span>
                <input type="number" className="psw-num-input"
                  value={unit === "cm" ? Math.round(heightMm / 10 * 10) / 10 : heightMm}
                  min={unit === "cm" ? config.min_size_mm / 10 : config.min_size_mm}
                  max={unit === "cm" ? config.max_size_mm / 10 : config.max_size_mm}
                  step={unit === "cm" ? 0.5 : 5}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setHeightMm(clamp(unit === "cm" ? v * 10 : v));
                  }}
                />
              </div>
            </div>
          )}
        </div>

        {cutStyle !== "square" && cutStyle !== "circle" && (
        <div className="psw-field">
          <div className="psw-label-row">
            <label className="psw-label">Cut line</label>
            <span className="psw-dim">
              {tightenLocal === 0
                ? "Default"
                : tightenLocal < 0
                  ? `Looser ${Math.abs(tightenLocal)}mm`
                  : `Tighter ${tightenLocal}mm`}
            </span>
          </div>
          <input
            type="range"
            min={-2}
            max={5}
            step={0.5}
            value={tightenLocal}
            onChange={(e) => setTightenLocal(parseFloat(e.target.value))}
            onMouseUp={() => regen({ tighten: tightenLocal })}
            onTouchEnd={() => regen({ tighten: tightenLocal })}
            onKeyUp={() => regen({ tighten: tightenLocal })}
          />
          <div className="psw-hint-row">
            <span>Looser</span>
            <span>Tighter</span>
          </div>
        </div>
        )}

        {config.show_hand_edit && result && (cutStyle === "bg_removal" || cutStyle === "die_cut" || cutStyle === "face" || cutStyle === "cut_around") && (
        <div className="psw-field">
          <button
            type="button"
            className="psw-edit-btn"
            onClick={() => setEditingCutline(true)}
            disabled={busy || !!aiStyling}
          >
            ✏️ Edit cut line by hand
          </button>
        </div>
        )}

        {(cutStyle === "keep_bg" || cutStyle === "square") && !isCanvasStyle && (
          <div className="psw-field">
            <div className="psw-label-row">
              <label className="psw-label">Corner radius</label>
              <span className="psw-dim">{Math.round(cornerRadius * 100)}%</span>
            </div>
            <input
              type="range"
              min={CORNER_MIN}
              max={1}
              step={0.01}
              value={cornerRadius}
              onChange={(e) => setCornerRadius(parseFloat(e.target.value))}
              onMouseUp={() => regen({ cornerRadius })}
              onTouchEnd={() => regen({ cornerRadius })}
              onKeyUp={() => regen({ cornerRadius })}
            />
            <div className="psw-hint-row">
              <span>Square</span>
              <span>Round</span>
            </div>
          </div>
        )}

        {isCanvasStyle && canvasShape === "rectangle" && (
          <div className="psw-field">
            <div className="psw-label-row">
              <label className="psw-label">Corner radius</label>
              <span className="psw-dim">{canvasCornerRadius} mm</span>
            </div>
            <input
              type="range"
              min={0}
              max={Math.min(widthMm, heightMm) / 2}
              step={0.5}
              value={canvasCornerRadius}
              onChange={(e) => setCanvasCornerRadius(Number(e.target.value))}
            />
            <div className="psw-hint-row">
              <span>Square</span>
              <span>Round</span>
            </div>
          </div>
        )}

        {isCanvasStyle && (
          <div className="psw-field">
            <div className="psw-label-row">
              <label className="psw-label">Bleed</label>
              <span className="psw-dim">{canvasBleed} mm</span>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={0.5}
              value={canvasBleed}
              onChange={(e) => setCanvasBleed(Number(e.target.value))}
            />
          </div>
        )}

        {config.vinyl_types.length > 0 && (
          <div className="psw-field">
            <label className="psw-label">Material</label>
            <div className="psw-option-btns">
              {config.vinyl_types.map((v) => (
                <button
                  key={v.key}
                  type="button"
                  className={`psw-option-btn${vinyl === v.key ? " psw-option-active" : ""}`}
                  onClick={() => setVinyl(v.key)}
                >
                  {v.label}
                  {(v.surcharge ?? 0) > 0 && <span className="psw-surcharge">+{money(v.surcharge!)}</span>}
                </button>
              ))}
            </div>
          </div>
        )}

        {config.finishes.length > 0 && (
          <div className="psw-field">
            <label className="psw-label">Extras</label>
            <div className="psw-extras-list">
              {config.finishes.map((v) => (
                <label key={v.key} className={`psw-extra-item${finish === v.key ? " psw-extra-active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={finish === v.key}
                    onChange={() => setFinish(finish === v.key ? null : v.key)}
                  />
                  <span className="psw-extra-label">{v.label}</span>
                  {(v.surcharge ?? 0) > 0 && <span className="psw-surcharge">+{money(v.surcharge!)}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="psw-field">
          <label className="psw-label">Quantity</label>
          {(config.quantity_presets ?? []).length > 0 ? (
            <div className="psw-qty-grid">
              {(config.quantity_presets ?? []).map((q) => {
                const bp = batchPrices.find((b) => b.quantity === q);
                return (
                  <label key={q} className={`psw-qty-option${quantity === q && !customQty ? " psw-qty-active" : ""}`}>
                    <input
                      type="radio"
                      name="psw-qty"
                      checked={quantity === q && !customQty}
                      onChange={() => { setCustomQty(false); setQuantity(q); }}
                    />
                    <span className="psw-qty-num">{q.toLocaleString()}</span>
                    {bp && <span className="psw-qty-unit">{money(bp.unit_price)} ea</span>}
                  </label>
                );
              })}
              {(config.allow_custom_quantity !== false) && (
                <label className={`psw-qty-option${customQty ? " psw-qty-active" : ""}`}>
                  <input
                    type="radio"
                    name="psw-qty"
                    checked={customQty}
                    onChange={() => setCustomQty(true)}
                  />
                  <span className="psw-qty-num">Custom</span>
                </label>
              )}
              {customQty && (
                <input
                  type="number"
                  min={1}
                  className="psw-qty-custom-input"
                  value={quantity}
                  onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
                />
              )}
            </div>
          ) : (
            <input
              type="number"
              min={1}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, parseInt(e.target.value, 10) || 1))}
            />
          )}
        </div>

        <div className="psw-price">
          {priceErr ? (
            <div className="psw-err">{priceErr}</div>
          ) : estimate ? (
            <>
              <div className="psw-price-total">
                {money(estimate.breakdown.total + (config.require_proof && proofChoice === "manual" ? (config.proof_fee ?? 0) : 0))}
              </div>
              <div className="psw-price-unit">
                {money(estimate.breakdown.unit_price)} each · {estimate.breakdown.quantity} stickers
                {estimate.breakdown.quantity_discount_pct > 0 &&
                  ` · ${estimate.breakdown.quantity_discount_pct}% off`}
                {config.require_proof && proofChoice === "manual" && (config.proof_fee ?? 0) > 0 &&
                  ` + ${money(config.proof_fee!)} proof fee`}
              </div>
            </>
          ) : (
            <div className="psw-price-unit">{pricing ? "Pricing…" : "—"}</div>
          )}
        </div>

        {config.require_proof && result && (
          <div className="psw-field psw-proof-section">
            <label className="psw-label">Design approval</label>
            <div className="psw-proof-options">
              <label className={`psw-proof-option${proofChoice === "approve" ? " psw-proof-active" : ""}`}>
                <input
                  type="radio"
                  name="psw-proof"
                  checked={proofChoice === "approve"}
                  onChange={() => setProofChoice("approve")}
                />
                <div>
                  <span className="psw-proof-title">I approve this design</span>
                  <span className="psw-proof-desc">Proceed straight to printing</span>
                </div>
              </label>
              <label className={`psw-proof-option${proofChoice === "manual" ? " psw-proof-active" : ""}`}>
                <input
                  type="radio"
                  name="psw-proof"
                  checked={proofChoice === "manual"}
                  onChange={() => setProofChoice("manual")}
                />
                <div>
                  <span className="psw-proof-title">Request a manual proof</span>
                  <span className="psw-proof-desc">
                    We'll review your design before printing
                    {(config.proof_fee ?? 0) > 0 && ` (+${money(config.proof_fee!)})`}
                  </span>
                </div>
              </label>
            </div>
            {proofChoice === "manual" && (
              <div className="psw-proof-details">
                <input
                  type="email"
                  className="psw-proof-email"
                  placeholder="Your email address *"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                  required
                />
                <textarea
                  className="psw-proof-note"
                  placeholder="Add a note (optional)"
                  value={proofNote}
                  onChange={(e) => setProofNote(e.target.value)}
                  rows={2}
                />
              </div>
            )}
          </div>
        )}

        <button
          className="psw-btn-primary"
          disabled={!estimate || busy || pricing || (config.require_proof && proofChoice === "manual" && !customerEmail)}
          onClick={addToCart}
        >
          {busy ? "Adding…" : "Add to cart"}
        </button>
      </div>
    </div>
  );
}

function DoneStep() {
  return (
    <div className="psw-card psw-done">
      <div className="psw-tick">✓</div>
      <h1 className="psw-h1">Added to your cart</h1>
      <p className="psw-sub">Your custom sticker design is on its way to checkout.</p>
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Bits
// --------------------------------------------------------------------------- //
function Centered({ children, tone }: { children: React.ReactNode; tone?: "error" }) {
  return (
    <div className="psw-root">
      <StyleTag />
      <div className={`psw-centered ${tone === "error" ? "is-error" : ""}`}>{children}</div>
    </div>
  );
}

function PoweredBy() {
  return (
    <div className="psw-powered-by">
      <a href="https://printlay.co.uk" target="_blank" rel="noopener noreferrer">
        Powered by <strong>PrintLay</strong>
      </a>
    </div>
  );
}

function currencySymbol(code: string): string {
  const map: Record<string, string> = { GBP: "£", USD: "$", EUR: "€", AUD: "$", CAD: "$" };
  return map[code] || `${code} `;
}

// --------------------------------------------------------------------------- //
// Live cut-line preview — draws the artwork + cut path on a canvas and offsets
// the path instantly (mm-isotropic) while the Cut-line slider is dragged. The
// accurate geometry is regenerated server-side when the slider is released.
// --------------------------------------------------------------------------- //
type Pt = [number, number];

function offsetPolygonMm(pts: Pt[], amount: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const ccw = area > 0;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const pr = pts[(i - 1 + n) % n];
    const nx = pts[(i + 1) % n];
    let e1x = p[0] - pr[0];
    let e1y = p[1] - pr[1];
    const l1 = Math.hypot(e1x, e1y) || 1;
    e1x /= l1;
    e1y /= l1;
    let e2x = nx[0] - p[0];
    let e2y = nx[1] - p[1];
    const l2 = Math.hypot(e2x, e2y) || 1;
    e2x /= l2;
    e2y /= l2;
    let n1x: number, n1y: number, n2x: number, n2y: number;
    if (ccw) {
      n1x = e1y;
      n1y = -e1x;
      n2x = e2y;
      n2y = -e2x;
    } else {
      n1x = -e1y;
      n1y = e1x;
      n2x = -e2y;
      n2y = e2x;
    }
    let vx = n1x + n2x;
    let vy = n1y + n2y;
    let ln = Math.hypot(vx, vy);
    if (ln < 1e-6) {
      vx = n1x;
      vy = n1y;
      ln = 1;
    }
    vx /= ln;
    vy /= ln;
    let cos = vx * n1x + vy * n1y;
    if (cos < 0.25) cos = 0.25;
    const m = amount / cos;
    out.push([p[0] + vx * m, p[1] + vy * m]);
  }
  return out;
}

function offsetNormPoints(points: Pt[], amountMm: number, widthMm: number, heightMm: number): Pt[] {
  if (widthMm <= 0 || heightMm <= 0 || points.length < 3) return points;
  const mm: Pt[] = points.map(([nx, ny]) => [nx * widthMm, ny * heightMm]);
  const off = offsetPolygonMm(mm, amountMm);
  return off.map(([x, y]) => [x / widthMm, y / heightMm]);
}

type Frame = {
  img: HTMLImageElement;
  points: Pt[];
  tighten: number;
  cornerRadius: number;
  widthMm: number;
  heightMm: number;
};

function roundedRectPoints(
  x1: number, y1: number, x2: number, y2: number, radiusFrac: number, segments = 8,
): Pt[] {
  const w = x2 - x1;
  const h = y2 - y1;
  const maxR = Math.min(w, h) / 2;
  const r = Math.max(0, Math.min(maxR, radiusFrac * maxR));
  if (r < 0.001) return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
  const pts: Pt[] = [];
  const corners: [number, number, number, number][] = [
    [x2 - r, y1 + r, -Math.PI / 2, 0],
    [x2 - r, y2 - r, 0, Math.PI / 2],
    [x1 + r, y2 - r, Math.PI / 2, Math.PI],
    [x1 + r, y1 + r, Math.PI, 3 * Math.PI / 2],
  ];
  for (const [cx, cy, startA, endA] of corners) {
    for (let i = 0; i <= segments; i++) {
      const a = startA + (endA - startA) * (i / segments);
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return pts;
}

function CutPreview({
  borderUrl,
  points,
  committedTighten,
  liveTighten,
  widthMm,
  heightMm,
  cutStyle,
  liveCornerRadius,
}: {
  borderUrl: string;
  points: Pt[];
  /** The tighten value the current `borderUrl`/`points` were rendered at. */
  committedTighten: number;
  /** The live slider value — the cut line is offset by the difference. */
  liveTighten: number;
  widthMm: number;
  heightMm: number;
  cutStyle?: string;
  liveCornerRadius?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [frame, setFrame] = useState<Frame | null>(null);
  const pending = useRef({ points, tighten: committedTighten, cornerRadius: liveCornerRadius ?? 0.01, widthMm, heightMm });
  pending.current = { points, tighten: committedTighten, cornerRadius: liveCornerRadius ?? 0.01, widthMm, heightMm };

  useEffect(() => {
    let cancelled = false;
    setFrame(null);
    const im = new Image();
    im.onload = () => {
      if (!cancelled)
        setFrame({
          img: im,
          points: pending.current.points,
          tighten: pending.current.tighten,
          cornerRadius: pending.current.cornerRadius,
          widthMm: pending.current.widthMm,
          heightMm: pending.current.heightMm,
        });
    };
    im.src = borderUrl;
    return () => {
      cancelled = true;
    };
  }, [borderUrl]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !frame) {
      if (c) {
        const ctx = c.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, c.width, c.height);
      }
      return;
    }
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { img } = frame;
    const maxDim = 900;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, c.width, c.height);

    let pts = frame.points || [];

    // Live tighten offset (polygon inward/outward).
    const offsetMm = liveTighten - frame.tighten;
    if (Math.abs(offsetMm) > 0.01 && pts.length > 2) {
      pts = offsetNormPoints(pts, -offsetMm, frame.widthMm, frame.heightMm);
    }

    // Live corner-radius for keep_bg: regenerate the rounded rect from the
    // bounding box of the current polygon with the live radius fraction.
    if ((cutStyle === "keep_bg" || cutStyle === "square") && liveCornerRadius !== undefined && pts.length > 2) {
      let minX = 1, minY = 1, maxX = 0, maxY = 0;
      for (const [px, py] of pts) {
        if (px < minX) minX = px;
        if (py < minY) minY = py;
        if (px > maxX) maxX = px;
        if (py > maxY) maxY = py;
      }
      pts = roundedRectPoints(minX, minY, maxX, maxY, liveCornerRadius);
    }

    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * c.width, pts[0][1] * c.height);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * c.width, pts[i][1] * c.height);
      ctx.closePath();
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#2684ff";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [frame, liveTighten, liveCornerRadius, cutStyle]);

  return <canvas ref={canvasRef} className="psw-canvas" />;
}

// Full-featured cut line editor for the embed widget (matches admin experience)
type EditTool = "redraw" | "smooth";

function polyArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j][0] + pts[i][0]) * (pts[j][1] - pts[i][1]);
  }
  return Math.abs(a / 2);
}

function arcForward(pts: [number, number][], from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let i = from;
  while (true) {
    out.push(pts[i]);
    if (i === to) break;
    i = (i + 1) % pts.length;
    if (out.length > pts.length) break;
  }
  return out;
}

function replaceArc(
  pts: [number, number][],
  startIdx: number,
  endIdx: number,
  stroke: [number, number][]
): [number, number][] {
  const n = pts.length;
  if (n < 3 || stroke.length < 2 || startIdx === endIdx) return pts;
  const aArc = arcForward(pts, (endIdx + 1) % n, (startIdx - 1 + n) % n);
  const polyA: [number, number][] = [...stroke, ...aArc];
  const bArc = arcForward(pts, (startIdx + 1) % n, (endIdx - 1 + n) % n).reverse();
  const polyB: [number, number][] = [...stroke, ...bArc];
  return polyArea(polyA) >= polyArea(polyB) ? polyA : polyB;
}

function EmbedCutlineEditor({
  borderUrl,
  points,
  onApply,
  onClose,
}: {
  borderUrl: string;
  points: [number, number][];
  onApply: (pts: [number, number][]) => void;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<EditTool>("redraw");
  const [brush, setBrush] = useState(40);
  const [dirty, setDirty] = useState(false);
  const busy = false;

  const undoStackRef = useRef<[number, number][][]>([]);
  const [undoCount, setUndoCount] = useState(0);

  function pushUndo() {
    const stack = undoStackRef.current;
    stack.push(ptsRef.current.map((p) => [...p] as [number, number]));
    if (stack.length > 10) stack.shift();
    setUndoCount(stack.length);
  }

  function doUndo() {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    ptsRef.current = stack.pop()!;
    setUndoCount(stack.length);
    setDirty(stack.length > 0);
    redraw();
  }

  const ptsRef = useRef<[number, number][]>([...points]);
  const drawingRef = useRef(false);
  const strokeRef = useRef<[number, number][]>([]);
  const startIdxRef = useRef(0);
  const brushPosRef = useRef<[number, number] | null>(null);
  const toolRef = useRef<EditTool>(tool);
  toolRef.current = tool;
  const brushRef = useRef(brush);
  brushRef.current = brush;

  useEffect(() => {
    setImg(null);
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => setImg(im);
    im.src = borderUrl;
  }, [borderUrl]);

  const brushRadiusPx = useCallback(() => {
    const c = canvasRef.current;
    const w = c ? c.width : 400;
    return w * (0.05 + (brushRef.current / 100) * 0.13);
  }, []);

  const redraw = useCallback(
    (opts?: { stroke?: [number, number][]; brush?: [number, number] | null }) => {
      const c = canvasRef.current;
      if (!c || !img) return;
      const ctx = c.getContext("2d");
      if (!ctx) return;
      const cw = c.width;
      const ch = c.height;
      ctx.clearRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);

      const pts = ptsRef.current;
      if (pts.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cw, ch);
        ctx.moveTo(pts[0][0] * cw, pts[0][1] * ch);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * cw, pts[i][1] * ch);
        ctx.closePath();
        ctx.fillStyle = "rgba(255,255,255,0.8)";
        ctx.fill("evenodd");
        ctx.restore();

        ctx.beginPath();
        ctx.moveTo(pts[0][0] * cw, pts[0][1] * ch);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * cw, pts[i][1] * ch);
        ctx.closePath();
        ctx.setLineDash([8, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#8b5cf6";
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const s = opts?.stroke;
      if (s && s.length > 1) {
        ctx.beginPath();
        ctx.moveTo(s[0][0] * cw, s[0][1] * ch);
        for (let i = 1; i < s.length; i++) ctx.lineTo(s[i][0] * cw, s[i][1] * ch);
        ctx.lineWidth = 3;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "#84cc16";
        ctx.stroke();
      }

      const b = opts && "brush" in opts ? opts.brush : brushPosRef.current;
      if (b) {
        ctx.beginPath();
        ctx.arc(b[0] * cw, b[1] * ch, brushRadiusPx(), 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(132,204,22,0.9)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    },
    [img, brushRadiusPx]
  );

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    const maxDim = 600;
    const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
    c.width = Math.round(img.naturalWidth * scale);
    c.height = Math.round(img.naturalHeight * scale);
    redraw();
  }, [img, redraw]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });

  function toNorm(e: React.PointerEvent): [number, number] {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    return [
      Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
    ];
  }

  function nearestIdx(n: [number, number]): number {
    const c = canvasRef.current!;
    const pts = ptsRef.current;
    let best = 0, bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = (pts[i][0] - n[0]) * c.width;
      const dy = (pts[i][1] - n[1]) * c.height;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  function smoothAt(n: [number, number]) {
    const c = canvasRef.current!;
    const cw = c.width, ch = c.height;
    const r = brushRadiusPx();
    const len = ptsRef.current.length;
    if (len < 7) return;
    const src0 = ptsRef.current;
    let inCount = 0;
    for (let i = 0; i < len; i++) {
      if (Math.hypot((src0[i][0] - n[0]) * cw, (src0[i][1] - n[1]) * ch) <= r) inCount++;
    }
    if (inCount < 2) return;
    const K = Math.max(2, Math.min(Math.floor(inCount / 4), 12));
    let pts = src0;
    for (let it = 0; it < 3; it++) {
      const src = pts;
      const out = src.slice() as [number, number][];
      for (let i = 0; i < len; i++) {
        const dist = Math.hypot((src[i][0] - n[0]) * cw, (src[i][1] - n[1]) * ch);
        if (dist > r) continue;
        const w = 1 - dist / r;
        let ax = 0, ay = 0;
        for (let k = 1; k <= K; k++) {
          ax += src[(i - k + len) % len][0] + src[(i + k) % len][0];
          ay += src[(i - k + len) % len][1] + src[(i + k) % len][1];
        }
        ax /= K * 2; ay /= K * 2;
        const lambda = Math.min(0.45, 0.4 * w);
        out[i] = [src[i][0] + (ax - src[i][0]) * lambda, src[i][1] + (ay - src[i][1]) * lambda];
      }
      pts = out;
    }
    ptsRef.current = pts;
  }

  function onDown(e: React.PointerEvent) {
    if (busy) return;
    e.preventDefault();
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const n = toNorm(e);
    drawingRef.current = true;
    if (toolRef.current === "redraw") {
      startIdxRef.current = nearestIdx(n);
      strokeRef.current = [n];
    } else {
      pushUndo();
      brushPosRef.current = n;
      smoothAt(n);
      setDirty(true);
      redraw({ brush: n });
    }
  }

  function onMove(e: React.PointerEvent) {
    const n = toNorm(e);
    if (!drawingRef.current) {
      if (toolRef.current === "smooth") { brushPosRef.current = n; redraw({ brush: n }); }
      return;
    }
    if (toolRef.current === "redraw") {
      const last = strokeRef.current[strokeRef.current.length - 1];
      const c = canvasRef.current!;
      if (((n[0] - last[0]) * c.width) ** 2 + ((n[1] - last[1]) * c.height) ** 2 < 9) return;
      strokeRef.current.push(n);
      redraw({ stroke: strokeRef.current });
    } else {
      brushPosRef.current = n;
      smoothAt(n);
      redraw({ brush: n });
    }
  }

  function onUp(e: React.PointerEvent) {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    const n = toNorm(e);
    if (toolRef.current === "redraw") {
      const endIdx = nearestIdx(n);
      const stroke = strokeRef.current;
      strokeRef.current = [];
      if (stroke.length < 2) { redraw(); return; }
      pushUndo();
      ptsRef.current = replaceArc(ptsRef.current, startIdxRef.current, endIdx, stroke);
      setDirty(true);
      redraw();
    } else {
      brushPosRef.current = n;
      redraw({ brush: n });
    }
  }

  function onLeave() {
    if (drawingRef.current) return;
    brushPosRef.current = null;
    redraw({ brush: null });
  }

  function resetPts() {
    ptsRef.current = [...points];
    undoStackRef.current = [];
    setUndoCount(0);
    setDirty(false);
    redraw();
  }

  return (
    <div className="psw-card" style={{ maxWidth: 560 }}>
      <div className="psw-cutline-tools">
        <button
          type="button"
          className={`psw-tool-btn ${tool === "redraw" ? "is-active" : ""}`}
          onClick={() => setTool("redraw")}
        >
          ✏️ Redraw
        </button>
        <button
          type="button"
          className={`psw-tool-btn ${tool === "smooth" ? "is-active" : ""}`}
          onClick={() => setTool("smooth")}
        >
          〰️ Smooth
        </button>
        <button
          type="button"
          className="psw-tool-btn"
          disabled={undoCount === 0}
          onClick={doUndo}
        >
          ↩ Undo
        </button>
      </div>

      {tool === "smooth" && (
        <div className="psw-brush-row">
          <span>Brush</span>
          <input type="range" min={10} max={100} step={5} value={brush} onChange={(e) => setBrush(+e.target.value)} />
        </div>
      )}

      <div className="psw-cutline-stage">
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onLeave}
          style={{ maxWidth: "100%", maxHeight: "55vh", height: "auto", display: "block", margin: "0 auto", touchAction: "none", cursor: "crosshair" }}
        />
        {busy && <div className="psw-spin" />}
      </div>

      <p style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", margin: "8px 0" }}>
        {tool === "redraw"
          ? "Drag from one spot on the cut line to another to redraw that section."
          : "Swipe back and forth over a notchy area to smooth it out."}
      </p>

      <div className="psw-cutline-actions">
        <button className="psw-apply-btn" disabled={!dirty || busy} onClick={() => onApply(ptsRef.current)}>
          Apply changes
        </button>
        <button className="psw-tool-btn" disabled={!dirty || busy} onClick={resetPts}>
          Reset
        </button>
        <button className={`psw-tool-btn ${dirty ? "psw-hidden" : ""}`} onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}

function StyleTag() {
  return <style>{CSS}</style>;
}

const CSS = `
html,body{margin:0;padding:0;overflow-x:hidden;width:100%}
.psw-root{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#fff;padding:16px;box-sizing:border-box;min-height:100%;overflow-x:hidden}
.psw-root *,.psw-root *::before,.psw-root *::after{box-sizing:border-box}
.psw-centered{display:flex;align-items:center;justify-content:center;min-height:60vh;color:#64748b;text-align:center;padding:24px}
.psw-centered.is-error{color:#be123c}
.psw-card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:20px;max-width:560px;margin:0 auto}
.psw-grid{display:grid;grid-template-columns:1fr;gap:16px;max-width:920px;margin:0 auto}
@media(min-width:760px){.psw-grid{grid-template-columns:1fr 380px}}
@media(max-width:759px){.psw-root{padding:10px}.psw-card{max-width:100%;width:100%;border-radius:12px;padding:14px}.psw-grid{gap:10px}.psw-preview-col{overflow:hidden}}
.psw-h1{font-size:20px;font-weight:700;margin:0 0 4px}
.psw-sub{color:#64748b;font-size:14px;margin:0 0 16px}
.psw-drop{border:2px dashed #cbd5e1;border-radius:14px;min-height:200px;display:flex;align-items:center;justify-content:center;cursor:pointer;overflow:hidden;background:#f8fafc;transition:border-color .15s}
.psw-drop:hover{border-color:#8b5cf6}
.psw-drop-img{max-height:220px;max-width:100%;object-fit:contain}
.psw-drop-empty{text-align:center;color:#64748b;font-size:14px;display:flex;flex-direction:column;gap:4px;padding:24px}
.psw-drop-empty strong{color:#0f172a}
.psw-drop-empty span{font-size:12px;color:#94a3b8}
.psw-field{margin-top:16px}
.psw-label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#64748b;margin-bottom:8px;font-weight:600}
.psw-label-row{display:flex;justify-content:space-between;align-items:baseline}
.psw-dim{font-size:12px;color:#475569}
.psw-chips{display:flex;flex-wrap:wrap;gap:8px}
.psw-chip{border:1px solid #cbd5e1;background:#fff;border-radius:999px;padding:7px 14px;font-size:13px;cursor:pointer;color:#334155}
.psw-chip.is-active{background:#0f172a;color:#fff;border-color:#0f172a}
.psw-chip:disabled{opacity:.5;cursor:default}
.psw-option-btns{display:flex;flex-wrap:wrap;gap:8px}
.psw-option-btn{border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:9px 16px;font-size:13px;font-weight:500;cursor:pointer;color:#334155;transition:border-color .15s,background .15s}
.psw-option-btn:hover{border-color:#8b5cf6;background:#faf5ff}
.psw-option-active{border-color:#8b5cf6;background:#f5f3ff;color:#6d28d9;font-weight:600}
.psw-surcharge{font-size:11px;color:#6d28d9;margin-left:4px;font-weight:600}
.psw-extras-list{display:flex;flex-direction:column;gap:8px}
.psw-extra-item{display:flex;align-items:center;gap:10px;border:1px solid #e2e8f0;border-radius:10px;padding:10px 14px;cursor:pointer;transition:border-color .15s,background .15s}
.psw-extra-item:hover{border-color:#8b5cf6;background:#faf5ff}
.psw-extra-active{border-color:#8b5cf6;background:#f5f3ff}
.psw-extra-item input[type=checkbox]{accent-color:#8b5cf6;width:16px;height:16px;margin:0}
.psw-extra-label{flex:1;font-size:13px;font-weight:500;color:#334155}
.psw-extra-active .psw-extra-label{color:#6d28d9;font-weight:600}
.psw-btn-primary{margin-top:20px;width:100%;background:#0f172a;color:#fff;border:0;border-radius:12px;padding:13px;font-size:15px;font-weight:600;cursor:pointer}
.psw-btn-primary:disabled{opacity:.45;cursor:default}
.psw-err{color:#be123c;font-size:13px;margin-top:12px}
.psw-preview{position:relative;background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;display:flex;align-items:center;justify-content:center;min-height:200px;overflow:hidden}
.psw-preview img,.psw-canvas{max-height:340px;max-width:100%;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto}
@media(max-width:759px){.psw-preview{min-height:180px;border-radius:10px}.psw-preview img,.psw-canvas{max-height:260px}}
.psw-preview.is-busy img,.psw-preview.is-busy .psw-canvas{opacity:.4}
.psw-spin{position:absolute;width:32px;height:32px;border:3px solid #cbd5e1;border-top-color:#8b5cf6;border-radius:50%;animation:psw-spin 0.8s linear infinite}
@keyframes psw-spin{to{transform:rotate(360deg)}}
.psw-filmstrip{display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;-webkit-overflow-scrolling:touch}
.psw-film{flex:0 0 auto;border:1px solid #e2e8f0;border-radius:10px;background:#fff;padding:4px;cursor:pointer;width:64px;text-align:center}
.psw-film.is-active{border-color:#8b5cf6;box-shadow:0 0 0 2px #ede9fe}
.psw-film img{width:54px;height:54px;object-fit:contain;border-radius:6px;background:#f8fafc}
.psw-film span{display:block;font-size:10px;color:#64748b;margin-top:2px}
.psw-film:disabled{opacity:.6}
.psw-hint-row{display:flex;justify-content:space-between;font-size:11px;color:#94a3b8;margin-top:2px}
.psw-options-col select,.psw-options-col input[type=number]{width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:14px;background:#fff;color:#0f172a}
.psw-options-col input[type=range],.psw-preview-col input[type=range]{width:100%;accent-color:#8b5cf6}
@media(max-width:759px){.psw-options-col{max-width:100%}}
.psw-price{margin-top:20px;padding-top:16px;border-top:1px solid #e2e8f0}
.psw-price-total{font-size:28px;font-weight:800;letter-spacing:-.02em}
.psw-price-unit{font-size:13px;color:#64748b;margin-top:2px}
.psw-done{text-align:center;padding:40px 20px}
.psw-tick{width:56px;height:56px;border-radius:50%;background:#dcfce7;color:#16a34a;font-size:28px;display:flex;align-items:center;justify-content:center;margin:0 auto 16px}
.psw-toolbar{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.psw-tool{display:inline-flex;align-items:center;gap:5px;border:1px solid #cbd5e1;background:#fff;border-radius:8px;padding:6px 9px;font-size:13px;color:#334155;cursor:pointer}
.psw-tool:hover{border-color:#8b5cf6}
.psw-tool:disabled{opacity:.4;cursor:default}
.psw-tool-danger:hover{border-color:#f43f5e;color:#e11d48}
.psw-tool-sep{width:1px;height:22px;background:#e2e8f0;margin:0 2px}
.psw-stage{display:flex;align-items:center;justify-content:center;background:repeating-conic-gradient(#f1f5f9 0% 25%,#fff 0% 50%) 50%/20px 20px;border:1px solid #e2e8f0;border-radius:12px;padding:18px;min-height:300px}
.psw-artboard{box-shadow:0 1px 6px rgba(0,0,0,.12);overflow:hidden;background:#fff}
.psw-swatches{display:flex;gap:6px;flex-wrap:wrap}
.psw-swatch{width:26px;height:26px;border-radius:7px;border:1px solid rgba(0,0,0,.15);cursor:pointer}
.psw-swatch.is-active{outline:2px solid #8b5cf6;outline-offset:1px}
.psw-select-sm{margin-top:8px;width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:7px 9px;font-size:13px;background:#fff;color:#0f172a}
/* ---- Shaped (canvas) designer: full-screen / mobile layouts ---- */
.psw-shaped{display:flex;flex-direction:column;gap:14px;max-width:1100px;margin:0 auto}
.psw-shaped--desktop{min-height:calc(100vh - 32px)}
.psw-shaped--mobile{max-width:480px}
.psw-shaped-bar{display:flex;align-items:center;justify-content:space-between;gap:12px}
.psw-shaped-title{font-size:16px;font-weight:700;color:#0f172a}
.psw-viewtoggle{display:inline-flex;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#f8fafc}
.psw-viewbtn{display:inline-flex;align-items:center;gap:5px;border:0;background:transparent;padding:7px 12px;font-size:13px;color:#64748b;cursor:pointer}
.psw-viewbtn.is-active{background:#0f172a;color:#fff}
.psw-shaped-body{display:flex;gap:16px;align-items:stretch;flex:1;min-height:0}
.psw-shaped-main{flex:1;min-width:0;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:18px;display:flex;flex-direction:column}
.psw-shaped-side{flex:0 0 320px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:18px;overflow:auto}
.psw-shaped-designctl{margin-top:2px}
.psw-shaped-main .psw-stage{flex:1;min-height:300px;padding:28px;overflow:auto}
.psw-shaped-side select,.psw-shaped-side input[type=number]{width:100%;border:1px solid #cbd5e1;border-radius:10px;padding:9px 10px;font-size:14px;background:#fff;color:#0f172a}
.psw-shaped-side input[type=range]{width:100%;accent-color:#8b5cf6}
.psw-shaped--mobile .psw-shaped-body{flex-direction:column}
.psw-shaped--mobile .psw-shaped-side{flex:1 1 auto;width:100%}
@media(max-width:759px){.psw-shaped-body{flex-direction:column}.psw-shaped-side{flex:1 1 auto;width:100%}}
/* Artboard + cut/safe guides */
.psw-board-wrap{position:relative;flex:0 0 auto}
.psw-guide{position:absolute;pointer-events:none;z-index:5}
.psw-guide-bleed{border:1.5px dashed #ef4444}
.psw-guide-cut{border:1.5px solid #10b981}
.psw-guide-safe{border:1.5px dashed #3b82f6}
.psw-legend{display:flex;flex-wrap:wrap;gap:14px;justify-content:center;margin-top:14px;font-size:12px;color:#64748b}
.psw-legend span{display:inline-flex;align-items:center;gap:6px}
.psw-dot{width:16px;border-top:2px solid #94a3b8;display:inline-block;height:0}
.psw-dot-sticker{border-top:2px solid #94a3b8}
.psw-dot-bleed{border-top:2px dashed #ef4444}
.psw-dot-cut{border-top:2px solid #10b981}
.psw-dot-safe{border-top:2px dashed #3b82f6}
.psw-toggle{display:flex;align-items:center;gap:8px;margin-top:12px;font-size:13px;color:#334155;cursor:pointer}
.psw-toggle input{width:16px;height:16px;accent-color:#8b5cf6;cursor:pointer}
.psw-unit-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
.psw-unit{display:inline-flex;border:1px solid #e2e8f0;border-radius:9px;overflow:hidden;background:#f8fafc}
.psw-unit button{border:0;background:transparent;padding:6px 14px;font-size:13px;color:#64748b;cursor:pointer}
.psw-unit button.is-active{background:#0f172a;color:#fff}
.psw-size-warning{margin-top:10px;padding:10px 14px;background:#fef3c7;border:1px solid #f59e0b;border-radius:10px;font-size:13px;color:#92400e;animation:psw-fade-in .2s ease}
@keyframes psw-fade-in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:translateY(0)}}
.psw-powered-by{text-align:center;padding:12px 0 4px;font-size:11px;color:#94a3b8;letter-spacing:.02em}
.psw-powered-by a{color:#94a3b8;text-decoration:none;transition:color .15s}
.psw-powered-by a:hover{color:#6366f1}
.psw-powered-by strong{font-weight:600;color:#64748b}
.psw-powered-by a:hover strong{color:#6366f1}
.psw-ai-styles{display:flex;flex-wrap:wrap;gap:6px}
.psw-ai-btn{border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:7px 12px;font-size:12px;color:#334155;cursor:pointer;transition:border-color .15s}
.psw-ai-btn:hover{border-color:#8b5cf6}
.psw-ai-btn:disabled{opacity:.5;cursor:default}
.psw-ai-btn.is-loading{border-color:#8b5cf6;color:#8b5cf6}
.psw-ai-custom{display:flex;gap:6px;margin-top:8px}
.psw-ai-input{flex:1;border:1px solid #e2e8f0;border-radius:8px;padding:7px 10px;font-size:12px;color:#0f172a}
.psw-ai-input:disabled{opacity:.5}
.psw-ai-go{min-width:40px}
.psw-edit-btn{width:100%;border:1px solid #e2e8f0;background:#fff;border-radius:10px;padding:10px;font-size:13px;color:#334155;cursor:pointer;transition:border-color .15s}
.psw-edit-btn:hover{border-color:#8b5cf6;color:#0f172a}
.psw-edit-btn:disabled{opacity:.5;cursor:default}
.psw-cutline-tools{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.psw-tool-btn{border:1px solid #e2e8f0;background:#fff;border-radius:8px;padding:7px 12px;font-size:12px;color:#334155;cursor:pointer;transition:border-color .15s}
.psw-tool-btn:hover{border-color:#8b5cf6}
.psw-tool-btn:disabled{opacity:.4;cursor:default}
.psw-tool-btn.is-active{background:#8b5cf6;color:#fff;border-color:#8b5cf6}
.psw-brush-row{display:flex;align-items:center;gap:8px;margin-bottom:8px;font-size:11px;color:#64748b}
.psw-brush-row input{flex:1;accent-color:#8b5cf6}
.psw-cutline-stage{position:relative;border:1px solid #e2e8f0;border-radius:10px;overflow:hidden;background:#f8fafc;padding:10px}
@media(max-width:759px){.psw-cutline-stage{padding:6px}}
.psw-cutline-actions{display:flex;gap:6px;margin-top:10px}
.psw-apply-btn{border:0;background:#8b5cf6;color:#fff;border-radius:8px;padding:8px 16px;font-size:13px;font-weight:600;cursor:pointer}
.psw-apply-btn:disabled{opacity:.4;cursor:default}
.psw-hidden{display:none}
.psw-qty-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.psw-qty-option{display:flex;align-items:center;gap:8px;border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;cursor:pointer;transition:border-color .15s,background .15s}
.psw-qty-option:hover{border-color:#8b5cf6;background:#faf5ff}
.psw-qty-active{border-color:#8b5cf6;background:#f5f3ff}
.psw-qty-option input[type=radio]{accent-color:#8b5cf6;margin:0;width:16px;height:16px}
.psw-qty-num{font-weight:600;font-size:14px}
.psw-qty-unit{font-size:12px;color:#16a34a;margin-left:auto;font-weight:500}
.psw-qty-custom-input{grid-column:1/-1;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-size:14px;width:100%}
.psw-qty-custom-input:focus{outline:none;border-color:#8b5cf6}
.psw-proof-section{margin-top:16px;padding-top:16px;border-top:1px solid #e2e8f0}
.psw-proof-options{display:flex;flex-direction:column;gap:8px}
.psw-proof-option{display:flex;align-items:flex-start;gap:10px;border:1px solid #e2e8f0;border-radius:10px;padding:12px;cursor:pointer;transition:border-color .15s,background .15s}
.psw-proof-option:hover{border-color:#8b5cf6;background:#faf5ff}
.psw-proof-active{border-color:#8b5cf6;background:#f5f3ff}
.psw-proof-option input[type=radio]{accent-color:#8b5cf6;margin-top:2px;width:16px;height:16px;flex-shrink:0}
.psw-proof-title{display:block;font-weight:600;font-size:14px;color:#0f172a}
.psw-proof-desc{display:block;font-size:12px;color:#64748b;margin-top:2px}
.psw-proof-details{margin-top:10px;display:flex;flex-direction:column;gap:8px}
.psw-proof-email,.psw-proof-note{border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px;font-size:14px;width:100%;font-family:inherit}
.psw-proof-email:focus,.psw-proof-note:focus{outline:none;border-color:#8b5cf6}
.psw-canvas-wrap{margin:12px 0;display:flex;flex-direction:column;align-items:center}
.psw-btn-row{display:flex;gap:8px;flex-wrap:wrap}
.psw-btn-small{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:6px 12px;font-size:12px;font-weight:500;cursor:pointer}
.psw-btn-small:hover{background:#e2e8f0}
.psw-btn-active{background:#6d28d9;color:#fff;border-color:#6d28d9}
.psw-btn-active:hover{background:#5b21b6}
.psw-btn-secondary{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:12px;padding:11px 16px;font-size:14px;font-weight:500;cursor:pointer;flex:1}
.psw-btn-secondary:hover{background:#e2e8f0}
.psw-fieldset{border:1px solid #e2e8f0;border-radius:12px;padding:14px 16px;margin:12px 0}
.psw-legend{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;padding:0 6px;font-weight:600}
.psw-dim-row{display:flex;gap:12px}
.psw-input-group{flex:1;display:flex;flex-direction:column;gap:4px}
.psw-input-label{font-size:12px;color:#64748b;font-weight:500}
.psw-num-input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:10px 12px;font-size:15px;font-weight:500;color:#0f172a;background:#f8fafc;font-family:inherit;outline:none;transition:border-color 0.15s}
.psw-num-input:focus{border-color:#8b5cf6;background:#fff}
.psw-num-input[readonly]{background:#f1f5f9;color:#64748b}
.psw-slider-row{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.psw-slider-label{font-size:12px;color:#64748b;font-weight:500}
.psw-range{width:100%;accent-color:#8b5cf6}
.psw-hint{font-size:12px;color:#94a3b8;margin:0 0 8px;text-align:center}
.psw-error{color:#be123c;font-size:13px;margin-top:8px}
@media(max-width:480px){.psw-dim-row{flex-direction:column;gap:8px}.psw-btn-row{justify-content:center}}
`;
