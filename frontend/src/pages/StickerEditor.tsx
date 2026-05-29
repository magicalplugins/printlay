import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ProcessResponse,
  processSticker,
  regenerateSticker,
  editCutline,
  saveSticker,
  aiStyleSticker,
  AI_STYLES,
} from "../api/sticker";
import { Category, createCategory, listCategories } from "../api/catalogue";
import { FILTER_PRESETS, filterCss } from "../components/app/SlotDesigner";
import { useMe } from "../auth/MeProvider";

type Step = "upload" | "options" | "processing" | "preview" | "saving" | "done";
type CutlineMode = "contour" | "rectangle" | "face";
type Precision = "tight" | "medium";

export default function StickerEditor() {
  const navigate = useNavigate();
  const { me } = useMe();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [cutlineMode, setCutlineMode] = useState<CutlineMode>("contour");
  // Cut quality is fixed at the good "medium" smoothing now; the user tunes
  // how close the cut hugs the subject via the Tighten slider instead.
  const precision: Precision = "medium";
  const [tighten, setTighten] = useState(0);
  // Photo look: a named colour preset (same as jobs) + beautify (0..100).
  const [filterId, setFilterId] = useState("none");
  const [bakedFilterId, setBakedFilterId] = useState("none");
  const [beautify, setBeautify] = useState({ smooth: 0, eyes: 0, tone: 0 });

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [stickerName, setStickerName] = useState<string>("");
  const [savedAssetId, setSavedAssetId] = useState<string | null>(null);

  useEffect(() => {
    listCategories()
      .then((cats) => {
        // Owned categories only (not read-only official subscriptions).
        const owned = cats.filter((c) => !c.is_official || !c.subscribed);
        setCategories(owned);
      })
      .catch(() => {});
  }, []);

  const handleFile = useCallback((f: File) => {
    setFile(f);
    setError(null);
    setPreview(URL.createObjectURL(f));
    setStickerName(f.name?.replace(/\.[^.]+$/, "") || "Sticker");
    setStep("options");
  }, []);

  const handleProcess = useCallback(async () => {
    if (!file) return;
    setStep("processing");
    setError(null);

    try {
      const method = cutlineMode === "rectangle" ? "none" : "auto";
      const res = await processSticker(file, method, 2.0, cutlineMode, precision);
      setResult(res);
      setTighten(0);
      setFilterId("none");
      setBakedFilterId("none");
      setBeautify({ smooth: 0, eyes: 0, tone: 0 });
      setStep("preview");
    } catch (e: any) {
      const msg =
        e?.body?.detail || e?.message || "Processing failed. Please try again.";
      setError(msg);
      setStep("options");
    }
  }, [file, cutlineMode, precision]);

  const [regenerating, setRegenerating] = useState(false);

  // Base white-border offset (mm) used at first generation; the Tighten
  // slider subtracts from this (positive = closer to / into the subject).
  const BASE_OFFSET_MM = 2.0;

  const applySettings = useCallback(
    async (next: {
      mode?: CutlineMode;
      tighten?: number;
      filterId?: string;
      smooth?: number;
      eyes?: number;
      tone?: number;
    }) => {
      if (!result) return;
      const mode = next.mode ?? cutlineMode;
      const t = next.tighten ?? tighten;
      const fid = next.filterId ?? filterId;
      const sm = next.smooth ?? beautify.smooth;
      const ey = next.eyes ?? beautify.eyes;
      const tn = next.tone ?? beautify.tone;
      setRegenerating(true);
      setError(null);
      try {
        const border = Math.max(-3, Math.min(6, BASE_OFFSET_MM - t));
        const res = await regenerateSticker(
          result.session_id,
          mode,
          "medium",
          border,
          3.0,
          {
            filterId: fid,
            beautifySmooth: sm / 100,
            beautifyEyes: ey / 100,
            beautifyTone: tn / 100,
          }
        );
        setResult(res);
        setCutlineMode(mode);
        setTighten(t);
        setFilterId(fid);
        setBakedFilterId(fid);
        setBeautify({ smooth: sm, eyes: ey, tone: tn });
      } catch (e: any) {
        const msg =
          e?.body?.detail || e?.message || "Could not update the sticker.";
        setError(msg);
      } finally {
        setRegenerating(false);
      }
    },
    [result, cutlineMode, tighten, filterId, beautify]
  );

  const handleEditApply = useCallback(
    async (points: [number, number][]) => {
      if (!result) return;
      setError(null);
      const res = await editCutline(result.session_id, points);
      setResult(res);
    },
    [result]
  );

  // AI illustration styles (cartoon, pencil, …) via the user's OpenAI key.
  // The stylized image replaces the working cutout, so any filter/beautify
  // baked onto the old artwork is reset to match the fresh server state.
  const [aiStyling, setAiStyling] = useState<string | null>(null);

  const handleAiStyle = useCallback(
    async (style: string) => {
      if (!result) return;
      setAiStyling(style);
      setError(null);
      try {
        const border = Math.max(-3, Math.min(6, BASE_OFFSET_MM - tighten));
        const res = await aiStyleSticker(
          result.session_id,
          style,
          border,
          3.0,
          cutlineMode
        );
        setResult(res);
        setFilterId("none");
        setBakedFilterId("none");
        setBeautify({ smooth: 0, eyes: 0, tone: 0 });
      } catch (e: any) {
        setError(
          e?.body?.detail ||
            e?.message ||
            "AI style failed. Please try again."
        );
      } finally {
        setAiStyling(null);
      }
    },
    [result, tighten, cutlineMode]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith("image/")) handleFile(f);
    },
    [handleFile]
  );

  const handleSave = useCallback(async () => {
    if (!result) return;
    setStep("saving");
    try {
      const name = stickerName.trim() || "Sticker";
      const saved = await saveSticker(result.session_id, name, categoryId);
      setSavedAssetId(saved.asset_id);
      setStep("done");
    } catch (e: any) {
      setError(
        typeof e?.body?.detail === "string"
          ? e.body.detail
          : e?.body?.detail?.message || "Save failed."
      );
      setStep("preview");
    }
  }, [result, stickerName, categoryId]);

  const handleCreateCategory = useCallback(async (name: string) => {
    const cat = await createCategory(name);
    setCategories((prev) => [...prev, cat]);
    setCategoryId(cat.id);
    return cat;
  }, []);

  const reset = useCallback(() => {
    setStep("upload");
    setFile(null);
    setPreview(null);
    setResult(null);
    setError(null);
  }, []);

  return (
    <div className="max-w-2xl mx-auto px-4 sm:px-6 py-8 sm:py-12">
      <div className="mb-8">
        <button
          onClick={() => navigate("/app/templates/new")}
          className="text-sm text-neutral-400 hover:text-white mb-4 inline-block"
        >
          ← Back to templates
        </button>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          Sticker Builder
        </h1>
        <p className="text-neutral-400 mt-1 text-sm">
          Upload artwork, we generate a print-ready sticker with die-cut line.
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-300">
          {error}
        </div>
      )}

      {step === "upload" && (
        <UploadZone
          dragOver={dragOver}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          onFileSelect={handleFile}
          fileRef={fileRef}
        />
      )}

      {step === "options" && preview && (
        <OptionsStep
          preview={preview}
          cutlineMode={cutlineMode}
          setCutlineMode={setCutlineMode}
          onProcess={handleProcess}
          onBack={reset}
        />
      )}

      {step === "processing" && <ProcessingState originalPreview={preview} />}

      {step === "preview" && result && (
        <PreviewState
          result={result}
          mode={cutlineMode}
          tighten={tighten}
          filterId={filterId}
          setFilterId={setFilterId}
          bakedFilterId={bakedFilterId}
          beautify={beautify}
          regenerating={regenerating}
          onApply={applySettings}
          onEditApply={handleEditApply}
          aiKeySet={!!me?.openai_key_set}
          aiStyling={aiStyling}
          onAiStyle={handleAiStyle}
          onAddKey={() => navigate("/app/settings?tab=preferences")}
          categories={categories}
          categoryId={categoryId}
          setCategoryId={setCategoryId}
          stickerName={stickerName}
          setStickerName={setStickerName}
          onCreateCategory={handleCreateCategory}
          onApprove={handleSave}
          onRetry={reset}
        />
      )}

      {step === "saving" && <SavingState />}

      {step === "done" && (
        <DoneState
          onAnother={reset}
          onGoToCatalogue={() => navigate("/app/catalogue")}
          onLayOnSheet={() =>
            navigate(
              savedAssetId ? `/app/sheets?asset=${savedAssetId}` : "/app/sheets"
            )
          }
        />
      )}
    </div>
  );
}

function OptionsStep({
  preview,
  cutlineMode,
  setCutlineMode,
  onProcess,
  onBack,
}: {
  preview: string;
  cutlineMode: CutlineMode;
  setCutlineMode: (m: CutlineMode) => void;
  onProcess: () => void;
  onBack: () => void;
}) {
  return (
    <div className="space-y-6">
      <button onClick={onBack} className="text-sm text-neutral-400 hover:text-white">
        ← Change image
      </button>

      <div className="flex justify-center">
        <img
          src={preview}
          alt="Preview"
          className="max-h-48 rounded-xl border border-neutral-800 object-contain"
        />
      </div>

      <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-4">
        <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
          Sticker type
        </legend>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ModeCard
            active={cutlineMode === "contour"}
            onClick={() => setCutlineMode("contour")}
            title="Background Removal"
            desc="Remove background and cut around the subject"
            icon={
              <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M16 4c-6 0-10 5-10 12s4 12 10 12 10-5 10-12S22 4 16 4z" strokeDasharray="3 2" />
              </svg>
            }
          />
          <ModeCard
            active={cutlineMode === "face"}
            onClick={() => setCutlineMode("face")}
            title="Face Sticker"
            desc="Cut around the head only — chin up to the hair"
            icon={
              <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5">
                <ellipse cx="16" cy="15" rx="8" ry="10" strokeDasharray="3 2" />
                <circle cx="13" cy="14" r="1" fill="currentColor" stroke="none" />
                <circle cx="19" cy="14" r="1" fill="currentColor" stroke="none" />
                <path d="M13 19c1.5 1.5 4.5 1.5 6 0" />
              </svg>
            }
          />
          <ModeCard
            active={cutlineMode === "rectangle"}
            onClick={() => setCutlineMode("rectangle")}
            title="Keep background"
            desc="Rounded rectangle sticker with full image"
            icon={
              <svg viewBox="0 0 32 32" className="w-8 h-8" fill="none" stroke="currentColor" strokeWidth="1.5">
                <rect x="4" y="6" width="24" height="20" rx="4" strokeDasharray="3 2" />
              </svg>
            }
          />
        </div>
        {cutlineMode === "face" && (
          <p className="text-xs text-neutral-500">
            Tip: use a clear, front-facing photo. We remove the background and
            place the cut line around the head and hair.
          </p>
        )}
      </fieldset>

      <p className="text-xs text-neutral-500 text-center">
        After generating you can tighten the cut line and hand-edit it.
      </p>

      <button
        onClick={onProcess}
        className="w-full rounded-xl bg-white px-6 py-3.5 font-semibold text-neutral-950 hover:bg-neutral-200 transition"
      >
        {cutlineMode === "rectangle"
          ? "Generate sticker"
          : cutlineMode === "face"
          ? "Create face sticker"
          : "Remove background & generate"}
      </button>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  title,
  desc,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  icon: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-left rounded-xl border p-4 transition ${
        active
          ? "border-violet-500 bg-violet-500/10"
          : "border-neutral-800 hover:border-neutral-600"
      }`}
    >
      <div className={`mb-2 ${active ? "text-violet-300" : "text-neutral-400"}`}>
        {icon}
      </div>
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-neutral-500 mt-0.5">{desc}</div>
    </button>
  );
}

function BeautifySlider({
  label,
  value,
  disabled,
  onChange,
  onCommit,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs text-neutral-400">{label}</div>
        <div className="text-xs text-neutral-500">{value}%</div>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(parseInt(e.target.value, 10))}
        onMouseUp={(e) => onCommit(parseInt((e.target as HTMLInputElement).value, 10))}
        onTouchEnd={(e) => onCommit(parseInt((e.target as HTMLInputElement).value, 10))}
        onKeyUp={(e) => onCommit(parseInt((e.target as HTMLInputElement).value, 10))}
        className="w-full accent-violet-500 disabled:opacity-50"
      />
    </div>
  );
}

function UploadZone({
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onFileSelect,
  fileRef,
}: {
  dragOver: boolean;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
  onFileSelect: (f: File) => void;
  fileRef: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <div
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => fileRef.current?.click()}
      className={`
        cursor-pointer rounded-2xl border-2 border-dashed p-12 sm:p-16
        text-center transition-all
        ${dragOver
          ? "border-violet-400 bg-violet-500/10"
          : "border-neutral-700 hover:border-neutral-500 bg-neutral-900/30"
        }
      `}
    >
      <input
        ref={fileRef as React.RefObject<HTMLInputElement>}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFileSelect(f);
        }}
      />
      <div className="mx-auto w-16 h-16 rounded-full bg-neutral-800 flex items-center justify-center mb-5">
        <svg className="w-8 h-8 text-neutral-400" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0l3 3m-3-3l-3 3M6.75 19.5a4.5 4.5 0 01-1.41-8.775 5.25 5.25 0 0110.338-2.32 3.375 3.375 0 014.112 4.095H18a3 3 0 01-3 3H6.75z" />
        </svg>
      </div>
      <p className="text-lg font-medium text-neutral-200">Drop your artwork here</p>
      <p className="text-sm text-neutral-500 mt-2">PNG, JPEG, or WebP — up to 25 MB</p>
      <button
        type="button"
        className="mt-6 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 transition"
      >
        Choose file
      </button>
    </div>
  );
}

function ProcessingState({ originalPreview }: { originalPreview: string | null }) {
  return (
    <div className="text-center py-16">
      {originalPreview && (
        <img src={originalPreview} alt="Uploading" className="mx-auto w-48 h-48 object-contain rounded-xl opacity-50 mb-8" />
      )}
      <div className="inline-flex items-center gap-3 text-neutral-300">
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-lg font-medium">Processing your sticker...</span>
      </div>
      <p className="text-sm text-neutral-500 mt-3">Generating cut line and border</p>
    </div>
  );
}

type Beautify = { smooth: number; eyes: number; tone: number };

function PreviewState({
  result,
  mode,
  tighten,
  filterId,
  setFilterId,
  bakedFilterId,
  beautify,
  regenerating,
  onApply,
  onEditApply,
  aiKeySet,
  aiStyling,
  onAiStyle,
  onAddKey,
  categories,
  categoryId,
  setCategoryId,
  stickerName,
  setStickerName,
  onCreateCategory,
  onApprove,
  onRetry,
}: {
  result: ProcessResponse;
  mode: CutlineMode;
  tighten: number;
  filterId: string;
  setFilterId: (id: string) => void;
  bakedFilterId: string;
  beautify: Beautify;
  regenerating: boolean;
  onApply: (next: {
    mode?: CutlineMode;
    tighten?: number;
    filterId?: string;
    smooth?: number;
    eyes?: number;
    tone?: number;
  }) => void;
  onEditApply: (points: [number, number][]) => Promise<void>;
  aiKeySet: boolean;
  aiStyling: string | null;
  onAiStyle: (style: string) => void;
  onAddKey: () => void;
  categories: Category[];
  categoryId: string | null;
  setCategoryId: (id: string | null) => void;
  stickerName: string;
  setStickerName: (n: string) => void;
  onCreateCategory: (name: string) => Promise<Category>;
  onApprove: () => void;
  onRetry: () => void;
}) {
  const [creatingCat, setCreatingCat] = useState(false);
  const [newCatName, setNewCatName] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [tightenLocal, setTightenLocal] = useState(tighten);
  const [beautyLocal, setBeautyLocal] = useState<Beautify>(beautify);

  useEffect(() => {
    setTightenLocal(tighten);
  }, [tighten]);

  useEffect(() => {
    setBeautyLocal(beautify);
  }, [beautify]);

  // Preview the colour preset instantly on the canvas (CSS) until it's baked
  // server-side. Once baked (bakedFilterId === filterId) we stop overlaying.
  const previewFilterCss =
    filterId !== bakedFilterId ? filterCss(filterId) : "none";

  async function handleCreate() {
    if (!newCatName.trim()) return;
    setCatBusy(true);
    try {
      await onCreateCategory(newCatName.trim());
      setNewCatName("");
      setCreatingCat(false);
    } catch {
      /* surfaced by parent on save */
    } finally {
      setCatBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl border border-neutral-800 bg-neutral-900/50 p-6 sm:p-8">
        <div className="text-sm text-neutral-400 mb-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          Sticker ready
        </div>

        {editing ? (
          <CutlineEditor
            borderUrl={result.border_url}
            points={result.cutline_points}
            onApply={onEditApply}
            onClose={() => setEditing(false)}
          />
        ) : result.cutline_points && result.cutline_points.length > 2 ? (
          <LivePreview
            borderUrl={result.border_url}
            points={result.cutline_points}
            offsetMm={tightenLocal - tighten}
            widthMm={result.width_mm}
            heightMm={result.height_mm}
            filterCssOverlay={previewFilterCss}
            busy={regenerating}
          />
        ) : (
          <div
            className="relative mx-auto rounded-xl overflow-hidden bg-repeat"
            style={{
              maxWidth: "400px",
              backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='10' height='10' fill='%23222'/%3E%3Crect x='10' y='10' width='10' height='10' fill='%23222'/%3E%3Crect x='10' width='10' height='10' fill='%23333'/%3E%3Crect y='10' width='10' height='10' fill='%23333'/%3E%3C/svg%3E")`,
            }}
          >
            <img src={result.preview_url} alt="Sticker preview" className="w-full h-auto" />
            {regenerating && (
              <div className="absolute inset-0 bg-neutral-950/60 flex items-center justify-center">
                <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
            )}
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs text-neutral-400">
          <div>
            <span className="text-neutral-500">Size</span>
            <div className="text-neutral-200 font-medium">
              {result.width_mm.toFixed(1)} × {result.height_mm.toFixed(1)} mm
            </div>
          </div>
          <div>
            <span className="text-neutral-500">Background</span>
            <div className="text-neutral-200 font-medium capitalize">
              {result.bg_type === "transparent" ? "Already transparent"
                : result.bg_type === "kept" ? "Kept (rectangle)"
                : result.removal_method === "solid_color" ? "Solid colour removed"
                : "AI removed"}
            </div>
          </div>
          <div>
            <span className="text-neutral-500">Cut line</span>
            <div className="text-neutral-200 font-medium">2mm white border</div>
          </div>
        </div>
      </div>

      {/* Adjust the cut line without re-uploading */}
      {mode !== "rectangle" && !editing && (
        <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-5">
          <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
            Adjust cut line
          </legend>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs text-neutral-400">Tighten</div>
              <div className="text-xs text-neutral-500">
                {tightenLocal <= 0
                  ? tightenLocal === 0
                    ? "Default"
                    : `Looser ${Math.abs(tightenLocal)}mm`
                  : `Tighter ${tightenLocal}mm`}
              </div>
            </div>
            <input
              type="range"
              min={-2}
              max={5}
              step={0.5}
              value={tightenLocal}
              disabled={regenerating}
              onChange={(e) => setTightenLocal(parseFloat(e.target.value))}
              onMouseUp={() => onApply({ tighten: tightenLocal })}
              onTouchEnd={() => onApply({ tighten: tightenLocal })}
              onKeyUp={() => onApply({ tighten: tightenLocal })}
              className="w-full accent-violet-500"
            />
            <div className="flex justify-between text-[10px] text-neutral-600 mt-1">
              <span>Looser</span>
              <span>Hugs subject</span>
              <span>Into subject</span>
            </div>
            <p className="text-[11px] text-neutral-500 mt-1">
              Keeps the same shape but pulls the cut line closer to (or into) the
              subject.
            </p>
          </div>

          <div>
            <div className="text-xs text-neutral-400 mb-2">Hand fix</div>
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={regenerating}
              className="w-full rounded-lg border border-neutral-700 px-4 py-2.5 text-sm text-neutral-200 hover:border-violet-500 hover:text-white transition disabled:opacity-40 flex items-center justify-center gap-2"
            >
              <svg viewBox="0 0 24 24" className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth="1.6">
                <path d="M16.5 4.5l3 3L8 19l-4 1 1-4 11.5-11.5z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Edit cut line by hand
            </button>
          </div>

          <p className="text-[11px] text-neutral-500">
            Changes re-use the removed background — no extra AI credits used.
          </p>
        </fieldset>
      )}

      {/* AI styles (OpenAI image-to-image, uses the user's own key) */}
      {!editing && (
        <fieldset className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-5 space-y-3">
          <legend className="px-2 text-xs uppercase tracking-widest text-violet-300/80">
            AI styles
          </legend>

          {!aiKeySet ? (
            <div className="text-sm text-neutral-300 space-y-2">
              <p>
                Turn your photo into a polished{" "}
                <span className="text-white font-medium">cartoon</span>,{" "}
                <span className="text-white font-medium">pencil sketch</span>,
                anime, pop-art or watercolour illustration.
              </p>
              <p className="text-[12px] text-neutral-400">
                Add your own OpenAI API key to unlock these — generation runs on
                your OpenAI account.
              </p>
              <button
                type="button"
                onClick={onAddKey}
                className="mt-1 rounded-lg bg-violet-600 px-4 py-2 text-sm font-semibold text-white hover:bg-violet-500 transition"
              >
                Add OpenAI key in Settings
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
                {AI_STYLES.map((s) => {
                  const loading = aiStyling === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      disabled={!!aiStyling || regenerating}
                      onClick={() => onAiStyle(s.id)}
                      title={s.blurb}
                      className="rounded-lg border border-neutral-700 px-2 py-3 text-center transition hover:border-violet-500 disabled:opacity-50"
                    >
                      {loading ? (
                        <svg className="animate-spin h-4 w-4 mx-auto text-violet-300" viewBox="0 0 24 24" fill="none">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                      ) : (
                        <div className="text-xs font-medium text-neutral-200">
                          {s.label}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-neutral-500">
                {aiStyling
                  ? "Generating your AI style — this can take 20–40 seconds."
                  : "Redraws the subject and re-cuts around it. Uses your OpenAI credits (~1 image)."}
              </p>
            </>
          )}
        </fieldset>
      )}

      {/* Photo filters (same presets as jobs) */}
      {!editing && (
        <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-3">
          <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
            Photo filter
          </legend>
          <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
            {FILTER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                disabled={regenerating}
                onClick={() => {
                  setFilterId(p.id);
                  onApply({ filterId: p.id });
                }}
                className={`rounded-lg overflow-hidden border text-center transition disabled:opacity-50 ${
                  filterId === p.id
                    ? "border-violet-500 ring-1 ring-violet-500"
                    : "border-neutral-700 hover:border-neutral-500"
                }`}
              >
                <div className="aspect-square bg-neutral-800 overflow-hidden">
                  <img
                    src={result.cutout_url || result.border_url}
                    alt={p.label}
                    className="w-full h-full object-cover"
                    style={{ filter: p.css }}
                  />
                </div>
                <div className="text-[10px] py-1 text-neutral-300 truncate px-1">
                  {p.label}
                </div>
              </button>
            ))}
          </div>
        </fieldset>
      )}

      {/* Beautify */}
      {!editing && (
        <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-4">
          <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
            Beautify
          </legend>
          <BeautifySlider
            label="Smooth skin"
            value={beautyLocal.smooth}
            disabled={regenerating}
            onChange={(v) => setBeautyLocal((b) => ({ ...b, smooth: v }))}
            onCommit={(v) => onApply({ smooth: v })}
          />
          <BeautifySlider
            label="Brighten eyes"
            value={beautyLocal.eyes}
            disabled={regenerating}
            onChange={(v) => setBeautyLocal((b) => ({ ...b, eyes: v }))}
            onCommit={(v) => onApply({ eyes: v })}
          />
          <BeautifySlider
            label="Even skin tone"
            value={beautyLocal.tone}
            disabled={regenerating}
            onChange={(v) => setBeautyLocal((b) => ({ ...b, tone: v }))}
            onCommit={(v) => onApply({ tone: v })}
          />
          <p className="text-[11px] text-neutral-500">
            Beautify works best on clear, front-facing portraits.
          </p>
        </fieldset>
      )}

      {/* Save destination */}
      {!editing && (
      <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-4">
        <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
          Save to catalogue
        </legend>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Name</label>
          <input
            type="text"
            value={stickerName}
            onChange={(e) => setStickerName(e.target.value)}
            placeholder="Sticker name"
            className="w-full rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
          />
        </div>

        <div>
          <label className="block text-xs text-neutral-400 mb-1">Catalogue</label>
          {!creatingCat ? (
            <div className="flex gap-2">
              <select
                value={categoryId ?? ""}
                onChange={(e) => setCategoryId(e.target.value || null)}
                className="flex-1 rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
              >
                <option value="">Stickers (default)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => setCreatingCat(true)}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-300 hover:border-neutral-500 whitespace-nowrap"
              >
                + New
              </button>
            </div>
          ) : (
            <div className="flex gap-2">
              <input
                type="text"
                value={newCatName}
                autoFocus
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  if (e.key === "Escape") setCreatingCat(false);
                }}
                placeholder="New catalogue name"
                className="flex-1 rounded-lg bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={catBusy || !newCatName.trim()}
                className="rounded-lg bg-white px-3 py-2 text-sm font-semibold text-neutral-950 disabled:opacity-40 whitespace-nowrap"
              >
                {catBusy ? "..." : "Create"}
              </button>
              <button
                type="button"
                onClick={() => setCreatingCat(false)}
                className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-400 hover:border-neutral-500"
              >
                Cancel
              </button>
            </div>
          )}
          <p className="text-[11px] text-neutral-500 mt-1.5">
            We&apos;ll create a &quot;Stickers&quot; catalogue automatically if you don&apos;t pick one.
          </p>
        </div>
      </fieldset>
      )}

      {!editing && (
      <div className="flex flex-col sm:flex-row gap-3">
        <button
          onClick={onApprove}
          disabled={regenerating}
          className="flex-1 rounded-xl bg-white px-6 py-3.5 font-semibold text-neutral-950 hover:bg-neutral-200 transition text-center disabled:opacity-50"
        >
          Save to catalogue
        </button>
        <button
          onClick={onRetry}
          className="flex-1 rounded-xl border border-neutral-700 px-6 py-3.5 font-medium text-neutral-300 hover:border-neutral-500 transition text-center"
        >
          Start over
        </button>
      </div>
      )}
    </div>
  );
}

// Offset a closed polygon by `amount` (positive = outward) using per-vertex
// averaged edge normals with a miter clamp. Used purely for an instant
// client-side preview while dragging the Tighten slider — the accurate
// geometry is regenerated on the server when the slider is released.
function offsetPolygonMm(
  pts: [number, number][],
  amount: number
): [number, number][] {
  const n = pts.length;
  if (n < 3) return pts;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    area += x1 * y2 - x2 * y1;
  }
  const ccw = area > 0;
  const out: [number, number][] = [];
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

// Offset normalised cut points by `amountMm` (positive = outward) in real mm
// space, so the offset is isotropic regardless of the sticker's aspect ratio.
function offsetNormPoints(
  points: [number, number][],
  amountMm: number,
  widthMm: number,
  heightMm: number
): [number, number][] {
  if (widthMm <= 0 || heightMm <= 0 || points.length < 3) return points;
  const mm: [number, number][] = points.map(([nx, ny]) => [
    nx * widthMm,
    ny * heightMm,
  ]);
  const off = offsetPolygonMm(mm, amountMm);
  return off.map(([x, y]) => [x / widthMm, y / heightMm]);
}

function LivePreview({
  borderUrl,
  points,
  offsetMm,
  widthMm,
  heightMm,
  filterCssOverlay,
  busy,
}: {
  borderUrl: string;
  points: [number, number][];
  offsetMm: number;
  widthMm: number;
  heightMm: number;
  filterCssOverlay?: string;
  busy: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    const im = new Image();
    im.onload = () => setImg(im);
    im.src = borderUrl;
  }, [borderUrl]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const maxDim = 800;
    const scale = Math.min(
      1,
      maxDim / Math.max(img.naturalWidth, img.naturalHeight)
    );
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    ctx.clearRect(0, 0, c.width, c.height);
    // Apply the colour preset as a live CSS-style canvas filter on the
    // artwork only (reset before drawing the cut line so it stays blue).
    ctx.filter =
      filterCssOverlay && filterCssOverlay !== "none"
        ? filterCssOverlay
        : "none";
    ctx.drawImage(img, 0, 0, c.width, c.height);
    ctx.filter = "none";

    let pts = points;
    // offsetMm > 0 means "tighter" → pull the cut line inward (negative offset)
    if (Math.abs(offsetMm) > 0.01 && points.length > 2) {
      pts = offsetNormPoints(points, -offsetMm, widthMm, heightMm);
    }
    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0] * c.width, pts[0][1] * c.height);
      for (let i = 1; i < pts.length; i++) {
        ctx.lineTo(pts[i][0] * c.width, pts[i][1] * c.height);
      }
      ctx.closePath();
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#2684ff";
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }, [img, points, offsetMm, widthMm, heightMm, filterCssOverlay]);

  return (
    <div
      className="relative mx-auto rounded-xl overflow-hidden bg-repeat"
      style={{
        maxWidth: "400px",
        backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='10' height='10' fill='%23222'/%3E%3Crect x='10' y='10' width='10' height='10' fill='%23222'/%3E%3Crect x='10' width='10' height='10' fill='%23333'/%3E%3Crect y='10' width='10' height='10' fill='%23333'/%3E%3C/svg%3E")`,
      }}
    >
      <canvas ref={canvasRef} className="w-full h-auto block" />
      {busy && (
        <div className="absolute inset-0 bg-neutral-950/40 flex items-center justify-center">
          <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}
    </div>
  );
}

function polyArea(poly: [number, number][]): number {
  let s = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

function arcForward(
  pts: [number, number][],
  from: number,
  to: number
): [number, number][] {
  const n = pts.length;
  const out: [number, number][] = [];
  let i = from;
  let guard = 0;
  while (guard++ <= n) {
    out.push(pts[i]);
    if (i === to) break;
    i = (i + 1) % n;
  }
  return out;
}

// Replace the cut-line stretch between two anchor points with a freehand
// stroke. We keep whichever of the two arcs yields the larger enclosed area
// (i.e. trims off the smaller "excess" the user drew across).
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

type EditTool = "redraw" | "smooth";

function CutlineEditor({
  borderUrl,
  points,
  onApply,
  onClose,
}: {
  borderUrl: string;
  points: [number, number][];
  onApply: (points: [number, number][]) => Promise<void>;
  onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [tool, setTool] = useState<EditTool>("redraw");
  const [brush, setBrush] = useState(40);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Live geometry lives in a ref so the smooth brush can mutate it every
  // pointer-move without forcing a React re-render of the whole editor.
  const ptsRef = useRef<[number, number][]>(points);
  const drawingRef = useRef(false);
  const strokeRef = useRef<[number, number][]>([]);
  const startIdxRef = useRef(0);
  const brushPosRef = useRef<[number, number] | null>(null);
  const toolRef = useRef<EditTool>(tool);
  toolRef.current = tool;
  const brushRef = useRef(brush);
  brushRef.current = brush;

  useEffect(() => {
    const im = new Image();
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
        ctx.beginPath();
        ctx.moveTo(pts[0][0] * cw, pts[0][1] * ch);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i][0] * cw, pts[i][1] * ch);
        }
        ctx.closePath();
        ctx.setLineDash([8, 5]);
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#2684ff";
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
        ctx.setLineDash([]);
        ctx.stroke();
      }
    },
    [img, brushRadiusPx]
  );

  // Size the canvas to the image and reset geometry when the source changes.
  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !img) return;
    const maxDim = 800;
    const scale = Math.min(
      1,
      maxDim / Math.max(img.naturalWidth, img.naturalHeight)
    );
    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
    c.height = Math.max(1, Math.round(img.naturalHeight * scale));
    redraw();
  }, [img, redraw]);

  useEffect(() => {
    ptsRef.current = points;
    setDirty(false);
    redraw();
  }, [points, redraw]);

  function toNorm(e: React.PointerEvent): [number, number] {
    const c = canvasRef.current!;
    const rect = c.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }

  function nearestIdx(n: [number, number]): number {
    const c = canvasRef.current!;
    const cw = c.width;
    const ch = c.height;
    const pts = ptsRef.current;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const dx = (pts[i][0] - n[0]) * cw;
      const dy = (pts[i][1] - n[1]) * ch;
      const d = dx * dx + dy * dy;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  }

  // One Laplacian relaxation pass on the points under the brush. Repeated
  // passes (swiping back and forth) progressively pull each point toward the
  // midpoint of its neighbours, melting away notches/jaggies.
  // Smooth the cut line under the brush. Runs several iterations of a
  // 5-tap (±2) windowed average per pointer event, weighted by a radial
  // falloff, so a single swipe visibly melts notches/indentations — and
  // brushing back and forth keeps relaxing the same area until it's smooth.
  function smoothAt(n: [number, number]) {
    const c = canvasRef.current!;
    const cw = c.width;
    const ch = c.height;
    const r = brushRadiusPx();
    const len = ptsRef.current.length;
    if (len < 7) return;
    let pts = ptsRef.current;
    const ITER = 5;
    for (let it = 0; it < ITER; it++) {
      const src = pts;
      const out = src.slice() as [number, number][];
      let touched = false;
      for (let i = 0; i < len; i++) {
        const dx = (src[i][0] - n[0]) * cw;
        const dy = (src[i][1] - n[1]) * ch;
        const dist = Math.hypot(dx, dy);
        if (dist > r) continue;
        touched = true;
        const w = 1 - dist / r; // 1 at centre → 0 at edge
        const a = src[(i - 2 + len) % len];
        const b = src[(i - 1 + len) % len];
        const d = src[(i + 1) % len];
        const e = src[(i + 2) % len];
        const ax = (a[0] + b[0] + src[i][0] + d[0] + e[0]) / 5;
        const ay = (a[1] + b[1] + src[i][1] + d[1] + e[1]) / 5;
        const lambda = Math.min(0.9, 0.85 * w);
        out[i] = [
          src[i][0] + (ax - src[i][0]) * lambda,
          src[i][1] + (ay - src[i][1]) * lambda,
        ];
      }
      pts = out;
      if (!touched) break;
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
      brushPosRef.current = n;
      smoothAt(n);
      setDirty(true);
      redraw({ brush: n });
    }
  }

  function onMove(e: React.PointerEvent) {
    const n = toNorm(e);
    if (!drawingRef.current) {
      // Show the brush ring on hover for the smooth tool.
      if (toolRef.current === "smooth") {
        brushPosRef.current = n;
        redraw({ brush: n });
      }
      return;
    }
    if (toolRef.current === "redraw") {
      const last = strokeRef.current[strokeRef.current.length - 1];
      const c = canvasRef.current!;
      const dx = (n[0] - last[0]) * c.width;
      const dy = (n[1] - last[1]) * c.height;
      if (dx * dx + dy * dy < 9) return;
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
      if (stroke.length < 2) {
        redraw();
        return;
      }
      ptsRef.current = replaceArc(
        ptsRef.current,
        startIdxRef.current,
        endIdx,
        stroke
      );
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

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      await onApply(ptsRef.current);
      onClose();
    } catch (e: any) {
      setErr(e?.body?.detail || e?.message || "Could not save the edit.");
    } finally {
      setBusy(false);
    }
  }

  function resetPts() {
    ptsRef.current = points;
    setDirty(false);
    redraw();
  }

  return (
    <div className="space-y-3">
      {/* Tool switcher */}
      <div className="flex items-center justify-center gap-2">
        <button
          type="button"
          onClick={() => setTool("redraw")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            tool === "redraw"
              ? "bg-violet-600 text-white"
              : "border border-neutral-700 text-neutral-300 hover:border-neutral-500"
          }`}
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M16.5 4.5l3 3L8 19l-4 1 1-4 11.5-11.5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Redraw
        </button>
        <button
          type="button"
          onClick={() => setTool("smooth")}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition ${
            tool === "smooth"
              ? "bg-violet-600 text-white"
              : "border border-neutral-700 text-neutral-300 hover:border-neutral-500"
          }`}
        >
          <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M4 16c4-8 12-8 16 0" strokeLinecap="round" />
          </svg>
          Smooth
        </button>
      </div>

      {tool === "smooth" && (
        <div className="flex items-center gap-3 max-w-[400px] mx-auto px-1">
          <span className="text-[11px] text-neutral-400 whitespace-nowrap">
            Brush size
          </span>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={brush}
            onChange={(e) => setBrush(parseInt(e.target.value, 10))}
            className="flex-1 accent-violet-500"
          />
        </div>
      )}

      <div
        className="relative mx-auto rounded-xl overflow-hidden border border-violet-500/40 bg-repeat"
        style={{
          maxWidth: "400px",
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='10' height='10' fill='%23222'/%3E%3Crect x='10' y='10' width='10' height='10' fill='%23222'/%3E%3Crect x='10' width='10' height='10' fill='%23333'/%3E%3Crect y='10' width='10' height='10' fill='%23333'/%3E%3C/svg%3E")`,
        }}
      >
        <canvas
          ref={canvasRef}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onLeave}
          className="w-full h-auto block touch-none cursor-crosshair"
        />
        {busy && (
          <div className="absolute inset-0 bg-neutral-950/60 flex items-center justify-center">
            <svg className="animate-spin h-6 w-6 text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
          </div>
        )}
      </div>

      <p className="text-[11px] text-neutral-400 text-center px-2">
        {tool === "redraw"
          ? "Drag from one spot on the blue cut line to another to redraw that section — the excess you draw across is trimmed off."
          : "Swipe back and forth over a notchy area to gradually smooth it out. The more you swipe, the smoother it gets."}
      </p>

      {err && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
          {err}
        </div>
      )}

      <div className="flex gap-3">
        <button
          type="button"
          onClick={apply}
          disabled={busy || !dirty}
          className="flex-1 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-500 transition disabled:opacity-40"
        >
          Apply changes
        </button>
        <button
          type="button"
          onClick={resetPts}
          disabled={busy || !dirty}
          className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300 hover:border-neutral-500 transition disabled:opacity-40"
        >
          Reset
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className="rounded-xl border border-neutral-700 px-4 py-2.5 text-sm text-neutral-300 hover:border-neutral-500 transition disabled:opacity-40"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SavingState() {
  return (
    <div className="text-center py-16">
      <div className="inline-flex items-center gap-3 text-neutral-300">
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-lg font-medium">Saving your sticker...</span>
      </div>
      <p className="text-sm text-neutral-500 mt-3">Generating print-ready PDF with CutContour</p>
    </div>
  );
}

function DoneState({
  onAnother,
  onGoToCatalogue,
  onLayOnSheet,
}: {
  onAnother: () => void;
  onGoToCatalogue: () => void;
  onLayOnSheet: () => void;
}) {
  return (
    <div className="text-center py-12">
      <div className="mx-auto w-16 h-16 rounded-full bg-emerald-500/20 flex items-center justify-center mb-5">
        <svg className="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      </div>
      <h2 className="text-xl font-bold text-neutral-100">Sticker saved!</h2>
      <p className="text-sm text-neutral-400 mt-2">
        Your sticker is now in your catalogue, ready to use in any job.
      </p>
      <div className="mt-8 flex flex-col sm:flex-row gap-3 justify-center">
        <button
          onClick={onLayOnSheet}
          className="rounded-xl bg-violet-600 px-6 py-3 font-semibold text-white hover:bg-violet-500 transition"
        >
          Lay on sheet
        </button>
        <button
          onClick={onAnother}
          className="rounded-xl bg-white px-6 py-3 font-semibold text-neutral-950 hover:bg-neutral-200 transition"
        >
          Make another sticker
        </button>
        <button
          onClick={onGoToCatalogue}
          className="rounded-xl border border-neutral-700 px-6 py-3 font-medium text-neutral-300 hover:border-neutral-500 transition"
        >
          View in catalogue
        </button>
      </div>
    </div>
  );
}
