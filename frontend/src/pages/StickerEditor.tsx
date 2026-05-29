import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ProcessResponse,
  processSticker,
  regenerateSticker,
  saveSticker,
} from "../api/sticker";
import { Category, createCategory, listCategories } from "../api/catalogue";

type Step = "upload" | "options" | "processing" | "preview" | "saving" | "done";
type CutlineMode = "contour" | "rectangle" | "face";
type Precision = "tight" | "medium";

export default function StickerEditor() {
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>("upload");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [cutlineMode, setCutlineMode] = useState<CutlineMode>("contour");
  const [precision, setPrecision] = useState<Precision>("medium");

  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [stickerName, setStickerName] = useState<string>("");

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
      setStep("preview");
    } catch (e: any) {
      const msg =
        e?.body?.detail || e?.message || "Processing failed. Please try again.";
      setError(msg);
      setStep("options");
    }
  }, [file, cutlineMode, precision]);

  const [regenerating, setRegenerating] = useState(false);

  const handleRegenerate = useCallback(
    async (mode: CutlineMode, prec: Precision) => {
      if (!result) return;
      setRegenerating(true);
      setError(null);
      try {
        const res = await regenerateSticker(result.session_id, mode, prec);
        setResult(res);
        setCutlineMode(mode);
        setPrecision(prec);
      } catch (e: any) {
        const msg =
          e?.body?.detail || e?.message || "Could not update the cut line.";
        setError(msg);
      } finally {
        setRegenerating(false);
      }
    },
    [result]
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
      await saveSticker(result.session_id, name, categoryId);
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
          precision={precision}
          setPrecision={setPrecision}
          onProcess={handleProcess}
          onBack={reset}
        />
      )}

      {step === "processing" && <ProcessingState originalPreview={preview} />}

      {step === "preview" && result && (
        <PreviewState
          result={result}
          mode={cutlineMode}
          precision={precision}
          regenerating={regenerating}
          onRegenerate={handleRegenerate}
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
        <DoneState onAnother={reset} onGoToCatalogue={() => navigate("/app/catalogue")} />
      )}
    </div>
  );
}

function OptionsStep({
  preview,
  cutlineMode,
  setCutlineMode,
  precision,
  setPrecision,
  onProcess,
  onBack,
}: {
  preview: string;
  cutlineMode: CutlineMode;
  setCutlineMode: (m: CutlineMode) => void;
  precision: Precision;
  setPrecision: (p: Precision) => void;
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

      <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-4">
        <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
          Cutline precision
        </legend>
        <div className="grid grid-cols-2 gap-3">
          <PrecisionCard
            active={precision === "tight"}
            onClick={() => setPrecision("tight")}
            title="Tight"
            desc="Close to subject edge"
          />
          <PrecisionCard
            active={precision === "medium"}
            onClick={() => setPrecision("medium")}
            title="Medium"
            desc="More buffer around subject"
          />
        </div>
      </fieldset>

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

function PrecisionCard({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
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
      <div className="text-sm font-semibold">{title}</div>
      <div className="text-xs text-neutral-500 mt-0.5">{desc}</div>
    </button>
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

function PreviewState({
  result,
  mode,
  precision,
  regenerating,
  onRegenerate,
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
  precision: Precision;
  regenerating: boolean;
  onRegenerate: (mode: CutlineMode, precision: Precision) => void;
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
      {mode !== "rectangle" && (
        <fieldset className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-4">
          <legend className="px-2 text-xs uppercase tracking-widest text-neutral-500">
            Adjust cut line
          </legend>

          <div>
            <div className="text-xs text-neutral-400 mb-2">Precision</div>
            <div className="grid grid-cols-2 gap-3">
              <PrecisionCard
                active={precision === "tight"}
                onClick={() => !regenerating && onRegenerate(mode, "tight")}
                title="Tight"
                desc="Close to subject edge"
              />
              <PrecisionCard
                active={precision === "medium"}
                onClick={() => !regenerating && onRegenerate(mode, "medium")}
                title="Medium"
                desc="More buffer around subject"
              />
            </div>
          </div>

          <div>
            <div className="text-xs text-neutral-400 mb-2">Cut around</div>
            <div className="grid grid-cols-2 gap-3">
              <PrecisionCard
                active={mode === "contour"}
                onClick={() => !regenerating && onRegenerate("contour", precision)}
                title="Whole subject"
                desc="Body and head"
              />
              <PrecisionCard
                active={mode === "face"}
                onClick={() => !regenerating && onRegenerate("face", precision)}
                title="Face only"
                desc="Chin up to the hair"
              />
            </div>
          </div>
          <p className="text-[11px] text-neutral-500">
            Changes re-use the removed background — no extra AI credits used.
          </p>
        </fieldset>
      )}

      {/* Save destination */}
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
}: {
  onAnother: () => void;
  onGoToCatalogue: () => void;
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
