import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AutoLayoutResult,
  CutterPreset,
  StickerSheet,
  autoLayout,
  createPreset,
  createSheet,
  exportSheetPdf,
  listPresets,
  listSheets,
  updateSheet,
} from "../api/sheets";
import { Asset, listAssets } from "../api/catalogue";
import { listCategories } from "../api/catalogue";
import { api } from "../api/client";

const MM_TO_PX = 2; // scale factor for canvas rendering at default zoom

export default function SheetBuilder() {
  // Data
  const [sheets, setSheets] = useState<StickerSheet[] | null>(null);
  const [activeSheet, setActiveSheet] = useState<StickerSheet | null>(null);
  const [presets, setPresets] = useState<CutterPreset[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Sheet creation form
  const [showNewSheet, setShowNewSheet] = useState(false);
  const [newName, setNewName] = useState("Untitled");
  const [newWidth, setNewWidth] = useState(700);

  // Auto-layout form
  const [layoutAssetId, setLayoutAssetId] = useState<string>("");
  const [layoutQty, setLayoutQty] = useState(10);
  const [layoutOrientation, setLayoutOrientation] = useState<
    "auto" | "horizontal" | "vertical"
  >("auto");
  const [layoutResult, setLayoutResult] = useState<AutoLayoutResult | null>(
    null
  );

  // Canvas
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [_panOffset] = useState({ x: 0, y: 0 });

  // Load data
  useEffect(() => {
    listSheets().then(setSheets).catch((e) => setErr(String(e)));
    listPresets().then(setPresets).catch(() => {});
    loadAssets();
  }, []);

  async function loadAssets() {
    try {
      const cats = await listCategories();
      const allAssets: Asset[] = [];
      for (const cat of cats) {
        const catAssets = await listAssets(cat.id);
        allAssets.push(...catAssets);
      }
      setAssets(allAssets);
    } catch {}
  }

  // Load thumbnail images for canvas rendering
  const [assetImages, setAssetImages] = useState<Record<string, HTMLImageElement>>({});

  useEffect(() => {
    if (!assets.length) return;
    const loaded: Record<string, HTMLImageElement> = {};
    let pending = 0;

    for (const a of assets) {
      const url = a.thumbnail_url || a.preview_url;
      if (!url || loaded[a.id]) continue;
      pending++;
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        loaded[a.id] = img;
        pending--;
        if (pending === 0) setAssetImages({ ...loaded });
      };
      img.onerror = () => {
        pending--;
        if (pending === 0) setAssetImages({ ...loaded });
      };
      img.src = url;
    }
    if (pending === 0 && Object.keys(loaded).length > 0) {
      setAssetImages(loaded);
    }
  }, [assets]);

  // Background image for sub-sheets
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!activeSheet?.sub_sheet_bg_url) {
      setBgImage(null);
      return;
    }
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setBgImage(img);
    img.onerror = () => setBgImage(null);
    img.src = activeSheet.sub_sheet_bg_url;
  }, [activeSheet?.sub_sheet_bg_url]);

  // Canvas draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSheet) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const scale = MM_TO_PX * zoom;
    const w = activeSheet.media_width_mm * scale;
    const h = activeSheet.media_height_mm * scale;

    const rulerSize = 40;
    canvas.width = w + rulerSize + 20;
    canvas.height = h + rulerSize + 20;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const ox = rulerSize + _panOffset.x;
    const oy = rulerSize + _panOffset.y;

    // Media background (the roll/full sheet)
    ctx.fillStyle = "#ffffff";
    ctx.shadowColor = "rgba(0,0,0,0.15)";
    ctx.shadowBlur = 12;
    ctx.fillRect(ox, oy, w, h);
    ctx.shadowBlur = 0;

    // Media border
    ctx.strokeStyle = "#d4d4d8";
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, w, h);

    // Draw sub-sheet groups (always visible when configured)
    if (activeSheet.sub_sheet_size) {
      _drawSubSheets(ctx, ox, oy, scale, activeSheet, bgImage);
    }

    // Draw placements (stickers)
    if (activeSheet.placements) {
      for (const p of activeSheet.placements) {
        const asset = assets.find((a) => a.id === p.asset_id);
        const pw = asset
          ? (asset.width_pt / (72 / 25.4)) * scale
          : 20 * scale;
        const ph = asset
          ? (asset.height_pt / (72 / 25.4)) * scale
          : 20 * scale;
        const px = ox + p.x_mm * scale;
        const py = oy + p.y_mm * scale;

        const rw = p.rotation_deg === 90 || p.rotation_deg === 270 ? ph : pw;
        const rh = p.rotation_deg === 90 || p.rotation_deg === 270 ? pw : ph;

        // Draw actual thumbnail or fallback rectangle
        const img = assetImages[p.asset_id];
        if (img) {
          ctx.save();
          if (p.rotation_deg) {
            ctx.translate(px + rw / 2, py + rh / 2);
            ctx.rotate((p.rotation_deg * Math.PI) / 180);
            ctx.drawImage(img, -pw / 2, -ph / 2, pw, ph);
          } else {
            ctx.drawImage(img, px, py, rw, rh);
          }
          ctx.restore();
        } else {
          ctx.fillStyle = "#f3f0ff";
          ctx.fillRect(px, py, rw, rh);
        }

        // Sticker border
        ctx.strokeStyle = "#7c3aed";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px, py, rw, rh);

        // Dashed cut line
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = "#3b82f6";
        ctx.lineWidth = 0.5;
        ctx.strokeRect(px - 1, py - 1, rw + 2, rh + 2);
        ctx.setLineDash([]);
      }
    }

    // Re-draw sub-sheet borders and crop marks ON TOP of stickers
    if (activeSheet.sub_sheet_size) {
      _drawSubSheetOverlay(ctx, ox, oy, scale, activeSheet);
    }

    // Draw rulers
    _drawRulers(ctx, ox, oy, w, h, scale, activeSheet);

    // Draw registration marks preview
    if (activeSheet.registration_type) {
      _drawRegMarksPreview(ctx, ox, oy, w, h, scale, activeSheet);
    }
  }, [activeSheet, zoom, _panOffset, assets, assetImages, bgImage]);

  useEffect(() => {
    draw();
  }, [draw]);

  // Preset handling
  async function applyPreset(preset: CutterPreset) {
    if (!activeSheet) return;
    const updated = await updateSheet(activeSheet.id, {
      media_width_mm: preset.media_width_mm,
      gap_mm: preset.default_gap_mm,
      edge_margin_mm: preset.default_edge_margin_mm,
      registration_type: preset.registration_type,
      max_zone_length_mm: preset.max_zone_length_mm,
      mark_offset_mm: preset.mark_offset_mm,
      show_crop_marks: preset.show_crop_marks,
      cutter_preset_id: preset.id,
    });
    setActiveSheet(updated);
  }

  async function handleCreateSheet() {
    try {
      const s = await createSheet({
        name: newName,
        media_width_mm: newWidth,
        media_height_mm: 300,
        mode: "roll",
      });
      setSheets((prev) => (prev ? [s, ...prev] : [s]));
      setActiveSheet(s);
      setShowNewSheet(false);
    } catch (e) {
      setErr(String(e));
    }
  }

  async function handleAutoLayout() {
    if (!activeSheet || !layoutAssetId) return;
    try {
      // Save current settings to backend first so auto-layout uses them
      await updateSheet(activeSheet.id, activeSheet);

      const result = await autoLayout(
        activeSheet.id,
        layoutAssetId,
        layoutQty,
        layoutOrientation
      );
      setLayoutResult(result);
      setActiveSheet((prev) =>
        prev
          ? {
              ...prev,
              placements: result.placements,
              media_height_mm: result.total_height_mm,
            }
          : null
      );
    } catch (e) {
      setErr(String(e));
    }
  }

  async function handleExport() {
    if (!activeSheet) return;
    setExporting(true);
    try {
      const blob = await exportSheetPdf(activeSheet.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${activeSheet.name}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setErr(String(e));
    } finally {
      setExporting(false);
    }
  }

  // Stats
  const stats = useMemo(() => {
    if (!activeSheet) return null;
    const count = activeSheet.placements?.length ?? 0;
    const metres = (activeSheet.media_height_mm / 1000).toFixed(2);
    return { count, metres };
  }, [activeSheet]);

  if (!activeSheet) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-bold text-white">Sheet Builder</h1>
          <button
            onClick={() => setShowNewSheet(true)}
            className="rounded-lg bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 text-sm font-medium"
          >
            + New Sheet
          </button>
        </div>

        {showNewSheet && (
          <div className="bg-neutral-900 border border-neutral-800 rounded-xl p-6 mb-6">
            <h2 className="text-lg font-semibold text-white mb-4">
              Create Sheet
            </h2>
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs text-neutral-400 mb-1">
                  Name
                </label>
                <input
                  type="text"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
                />
              </div>
              <div>
                <label className="block text-xs text-neutral-400 mb-1">
                  Media width (mm)
                </label>
                <input
                  type="number"
                  value={newWidth}
                  onChange={(e) => setNewWidth(Number(e.target.value))}
                  className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
                />
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreateSheet}
                className="rounded-md bg-violet-600 hover:bg-violet-500 text-white px-4 py-2 text-sm font-medium"
              >
                Create
              </button>
              <button
                onClick={() => setShowNewSheet(false)}
                className="rounded-md bg-neutral-800 hover:bg-neutral-700 text-neutral-300 px-4 py-2 text-sm"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {sheets && sheets.length > 0 ? (
          <div className="grid gap-3">
            {sheets.map((s) => (
              <button
                key={s.id}
                onClick={() => setActiveSheet(s)}
                className="w-full text-left bg-neutral-900 border border-neutral-800 hover:border-violet-500/50 rounded-xl p-4 transition-colors"
              >
                <div className="font-medium text-white">{s.name}</div>
                <div className="text-xs text-neutral-400 mt-1">
                  {s.media_width_mm}mm wide · {s.placements?.length ?? 0}{" "}
                  stickers · {(s.media_height_mm / 1000).toFixed(2)}m
                </div>
              </button>
            ))}
          </div>
        ) : sheets ? (
          <p className="text-neutral-500 text-sm">
            No sheets yet. Create one to get started.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Top bar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-950/80">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setActiveSheet(null)}
            className="text-neutral-400 hover:text-white text-sm"
          >
            &larr; Back
          </button>
          <h2 className="text-white font-semibold">{activeSheet.name}</h2>
          <span className="text-xs text-neutral-500">
            {activeSheet.media_width_mm}mm &times;{" "}
            {activeSheet.media_height_mm.toFixed(0)}mm
          </span>
        </div>
        <div className="flex items-center gap-2">
          {stats && (
            <span className="text-xs text-neutral-400 mr-3">
              {stats.count} stickers · {stats.metres}m
            </span>
          )}
          <button
            onClick={handleExport}
            disabled={
              exporting || !activeSheet.placements?.length
            }
            className="rounded-md bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white px-4 py-1.5 text-sm font-medium"
          >
            {exporting ? "Exporting..." : "Export PDF"}
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Canvas area */}
        <div className="flex-1 overflow-auto bg-neutral-950 flex items-start justify-center p-6">
          <canvas
            ref={canvasRef}
            className="rounded-lg"
            style={{ imageRendering: "crisp-edges" }}
          />
        </div>

        {/* Right panel */}
        <div className="w-80 border-l border-neutral-800 bg-neutral-900 overflow-y-auto p-4 space-y-6">
          {/* Cutter preset */}
          {presets.length > 0 && (
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
                Cutter Preset
              </h3>
              <select
                value={activeSheet.cutter_preset_id ?? ""}
                onChange={(e) => {
                  const p = presets.find((pr) => pr.id === e.target.value);
                  if (p) applyPreset(p);
                }}
                className="w-full rounded-md bg-neutral-800 border border-neutral-700 px-3 py-2 text-sm text-white"
              >
                <option value="">None</option>
                {presets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </section>
          )}

          {/* Settings */}
          <section>
            <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
              Sheet Settings
            </h3>
            <div className="space-y-3">
              <SettingRow label="Sticker gap (mm)">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={activeSheet.gap_mm}
                  onChange={(e) =>
                    setActiveSheet((s) =>
                      s ? { ...s, gap_mm: Number(e.target.value) } : null
                    )
                  }
                  className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                />
              </SettingRow>
              <SettingRow label="Edge margin (mm)">
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={activeSheet.edge_margin_mm}
                  onChange={(e) =>
                    setActiveSheet((s) =>
                      s
                        ? { ...s, edge_margin_mm: Number(e.target.value) }
                        : null
                    )
                  }
                  className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                />
              </SettingRow>
              <SettingRow label="Sub-sheet size">
                <select
                  value={activeSheet.sub_sheet_size ?? ""}
                  onChange={(e) =>
                    setActiveSheet((s) =>
                      s
                        ? {
                            ...s,
                            sub_sheet_size: e.target.value || null,
                            show_crop_marks: !!e.target.value,
                          }
                        : null
                    )
                  }
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                >
                  <option value="">None (full roll)</option>
                  <option value="a5">A5 (148 × 210mm)</option>
                  <option value="a4">A4 (210 × 297mm)</option>
                  <option value="a3">A3 (297 × 420mm)</option>
                </select>
              </SettingRow>
              {activeSheet.sub_sheet_size && (
                <>
                  <SettingRow label="Sub-sheet gap (mm)">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={activeSheet.sub_sheet_gap_mm ?? 5}
                      onChange={(e) =>
                        setActiveSheet((s) =>
                          s
                            ? { ...s, sub_sheet_gap_mm: Number(e.target.value) }
                            : null
                        )
                      }
                      className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                    />
                  </SettingRow>
                  <SettingRow label="Inner padding (mm)">
                    <input
                      type="number"
                      min={0}
                      step={0.5}
                      value={activeSheet.sub_sheet_padding_mm ?? 5}
                      onChange={(e) =>
                        setActiveSheet((s) =>
                          s
                            ? {
                                ...s,
                                sub_sheet_padding_mm: Number(e.target.value),
                              }
                            : null
                        )
                      }
                      className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                    />
                  </SettingRow>
                  <SettingRow label="Crop marks">
                    <input
                      type="checkbox"
                      checked={activeSheet.show_crop_marks}
                      onChange={(e) =>
                        setActiveSheet((s) =>
                          s
                            ? { ...s, show_crop_marks: e.target.checked }
                            : null
                        )
                      }
                      className="rounded"
                    />
                  </SettingRow>
                </>
              )}
              <SettingRow label="Registration">
                <select
                  value={activeSheet.registration_type ?? ""}
                  onChange={(e) =>
                    setActiveSheet((s) =>
                      s
                        ? {
                            ...s,
                            registration_type: e.target.value || null,
                          }
                        : null
                    )
                  }
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                >
                  <option value="">None</option>
                  <option value="velloblade">Velloblade</option>
                  <option value="summa_opos">Summa OPOS</option>
                  <option value="generic">Generic</option>
                </select>
              </SettingRow>
              {activeSheet.registration_type && (
                <SettingRow label="Max zone (mm)">
                  <input
                    type="number"
                    min={100}
                    step={50}
                    value={activeSheet.max_zone_length_mm ?? ""}
                    placeholder="No limit"
                    onChange={(e) =>
                      setActiveSheet((s) =>
                        s
                          ? {
                              ...s,
                              max_zone_length_mm: e.target.value
                                ? Number(e.target.value)
                                : null,
                            }
                          : null
                      )
                    }
                    className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                  />
                </SettingRow>
              )}
            </div>
          </section>

          {/* Sub-sheet customisation */}
          {activeSheet.sub_sheet_size && (
            <section>
              <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
                Sub-Sheet Design
              </h3>
              <div className="space-y-3">
                {/* Sticker alignment */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">
                    Sticker alignment
                  </label>
                  <div className="flex gap-2">
                    <select
                      value={activeSheet.sticker_align_h ?? "center"}
                      onChange={(e) =>
                        setActiveSheet((s) =>
                          s
                            ? { ...s, sticker_align_h: e.target.value }
                            : null
                        )
                      }
                      className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                    >
                      <option value="left">Left</option>
                      <option value="center">Centre</option>
                      <option value="right">Right</option>
                    </select>
                    <select
                      value={activeSheet.sticker_align_v ?? "top"}
                      onChange={(e) =>
                        setActiveSheet((s) =>
                          s
                            ? { ...s, sticker_align_v: e.target.value }
                            : null
                        )
                      }
                      className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                    >
                      <option value="top">Top</option>
                      <option value="center">Middle</option>
                      <option value="bottom">Bottom</option>
                    </select>
                  </div>
                </div>

                {/* Background image upload */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">
                    Background image
                    {activeSheet.sub_sheet_bg_url && (
                      <span className="text-violet-400 ml-1">(overrides colours)</span>
                    )}
                  </label>
                  {activeSheet.sub_sheet_bg_url ? (
                    <div className="relative">
                      <img
                        src={activeSheet.sub_sheet_bg_url}
                        alt="bg"
                        className="w-full h-16 object-cover rounded border border-neutral-700"
                      />
                      <button
                        onClick={() =>
                          setActiveSheet((s) =>
                            s
                              ? { ...s, sub_sheet_bg_url: null }
                              : null
                          )
                        }
                        className="absolute top-1 right-1 bg-black/60 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs"
                      >
                        &times;
                      </button>
                    </div>
                  ) : (
                    <label className="flex items-center justify-center w-full h-10 rounded bg-neutral-800 border border-dashed border-neutral-600 hover:border-violet-500 cursor-pointer text-xs text-neutral-400 hover:text-white transition-colors">
                      <span>Upload image...</span>
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file || !activeSheet) return;
                          const formData = new FormData();
                          formData.append("file", file);
                          try {
                            const resp = await api<{ url: string }>(
                              `/api/sheets/${activeSheet.id}/bg-upload`,
                              {
                                method: "POST",
                                body: formData,
                              }
                            );
                            setActiveSheet((s) =>
                              s
                                ? { ...s, sub_sheet_bg_url: resp.url }
                                : null
                            );
                          } catch {}
                        }}
                      />
                    </label>
                  )}
                </div>

                {/* Background colour — hidden if image uploaded */}
                {!activeSheet.sub_sheet_bg_url && (
                  <>
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1">
                        Background colour
                      </label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={activeSheet.sub_sheet_fill_color || "#ffffff"}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? { ...s, sub_sheet_fill_color: e.target.value }
                                : null
                            )
                          }
                          className="w-8 h-8 rounded border border-neutral-700 bg-neutral-800 cursor-pointer"
                        />
                        <input
                          type="text"
                          placeholder="#ffffff"
                          value={activeSheet.sub_sheet_fill_color ?? ""}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? {
                                    ...s,
                                    sub_sheet_fill_color: e.target.value || null,
                                  }
                                : null
                            )
                          }
                          className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                        />
                        {activeSheet.sub_sheet_fill_color && (
                          <button
                            onClick={() =>
                              setActiveSheet((s) =>
                                s
                                  ? { ...s, sub_sheet_fill_color: null, sub_sheet_fill_color2: null }
                                  : null
                              )
                            }
                            title="Clear (transparent)"
                            className="text-xs text-neutral-500 hover:text-white px-1"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Second colour for gradient */}
                    <div>
                      <label className="block text-xs text-neutral-400 mb-1">
                        2nd colour (gradient)
                      </label>
                      <div className="flex gap-2 items-center">
                        <input
                          type="color"
                          value={activeSheet.sub_sheet_fill_color2 || "#000000"}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? { ...s, sub_sheet_fill_color2: e.target.value }
                                : null
                            )
                          }
                          className="w-8 h-8 rounded border border-neutral-700 bg-neutral-800 cursor-pointer"
                        />
                        <input
                          type="text"
                          placeholder="None (solid)"
                          value={activeSheet.sub_sheet_fill_color2 ?? ""}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? {
                                    ...s,
                                    sub_sheet_fill_color2: e.target.value || null,
                                  }
                                : null
                            )
                          }
                          className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                        />
                        {activeSheet.sub_sheet_fill_color2 && (
                          <button
                            onClick={() =>
                              setActiveSheet((s) =>
                                s
                                  ? { ...s, sub_sheet_fill_color2: null }
                                  : null
                              )
                            }
                            title="Remove gradient"
                            className="text-xs text-neutral-500 hover:text-white px-1"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Gradient angle (only if 2 colours set) */}
                    {activeSheet.sub_sheet_fill_color2 && (
                      <SettingRow label="Gradient angle (°)">
                        <input
                          type="number"
                          min={0}
                          max={360}
                          step={15}
                          value={activeSheet.sub_sheet_gradient_angle ?? 135}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? {
                                    ...s,
                                    sub_sheet_gradient_angle: Number(e.target.value),
                                  }
                                : null
                            )
                          }
                          className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                        />
                      </SettingRow>
                    )}

                    {/* Preview swatch */}
                    {(activeSheet.sub_sheet_fill_color ||
                      activeSheet.sub_sheet_fill_color2) && (
                      <div
                        className="h-5 rounded border border-neutral-700"
                        style={{
                          background: activeSheet.sub_sheet_fill_color2
                            ? `linear-gradient(${activeSheet.sub_sheet_gradient_angle ?? 135}deg, ${activeSheet.sub_sheet_fill_color || "#ffffff"}, ${activeSheet.sub_sheet_fill_color2})`
                            : activeSheet.sub_sheet_fill_color || undefined,
                        }}
                      />
                    )}
                  </>
                )}

                {/* Bleed */}
                <SettingRow label="Background bleed (mm)">
                  <input
                    type="number"
                    min={0}
                    max={20}
                    step={0.5}
                    value={activeSheet.sub_sheet_bleed_mm ?? 0}
                    onChange={(e) =>
                      setActiveSheet((s) =>
                        s
                          ? {
                              ...s,
                              sub_sheet_bleed_mm: Number(e.target.value),
                            }
                          : null
                      )
                    }
                    className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white text-right"
                  />
                </SettingRow>

                {/* Title */}
                <div>
                  <label className="block text-xs text-neutral-400 mb-1">
                    Title
                  </label>
                  <input
                    type="text"
                    placeholder="Sheet title..."
                    value={activeSheet.sub_sheet_title ?? ""}
                    onChange={(e) =>
                      setActiveSheet((s) =>
                        s
                          ? { ...s, sub_sheet_title: e.target.value || null }
                          : null
                      )
                    }
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                  />
                </div>
                {activeSheet.sub_sheet_title && (
                  <>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label className="block text-xs text-neutral-400 mb-1">
                          Font
                        </label>
                        <select
                          value={activeSheet.sub_sheet_title_font ?? "Inter"}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? {
                                    ...s,
                                    sub_sheet_title_font: e.target.value,
                                  }
                                : null
                            )
                          }
                          className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                        >
                          <option value="Inter">Inter</option>
                          <option value="Arial">Arial</option>
                          <option value="Helvetica">Helvetica</option>
                          <option value="Georgia">Georgia</option>
                          <option value="Times New Roman">Times New Roman</option>
                          <option value="Courier New">Courier New</option>
                          <option value="Comic Sans MS">Comic Sans MS</option>
                        </select>
                      </div>
                      <div className="w-16">
                        <label className="block text-xs text-neutral-400 mb-1">
                          Size
                        </label>
                        <input
                          type="number"
                          min={2}
                          max={20}
                          step={0.5}
                          value={activeSheet.sub_sheet_title_size_mm ?? 5}
                          onChange={(e) =>
                            setActiveSheet((s) =>
                              s
                                ? {
                                    ...s,
                                    sub_sheet_title_size_mm: Number(
                                      e.target.value
                                    ),
                                  }
                                : null
                            )
                          }
                          className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                        />
                      </div>
                    </div>
                    <div className="flex gap-2 items-center">
                      <div className="flex-1">
                        <label className="block text-xs text-neutral-400 mb-1">
                          Title colour
                        </label>
                        <div className="flex gap-2 items-center">
                          <input
                            type="color"
                            value={activeSheet.sub_sheet_title_color || "#000000"}
                            onChange={(e) =>
                              setActiveSheet((s) =>
                                s
                                  ? { ...s, sub_sheet_title_color: e.target.value }
                                  : null
                              )
                            }
                            className="w-7 h-7 rounded border border-neutral-700 bg-neutral-800 cursor-pointer"
                          />
                          <input
                            type="text"
                            value={activeSheet.sub_sheet_title_color ?? "#000000"}
                            onChange={(e) =>
                              setActiveSheet((s) =>
                                s
                                  ? { ...s, sub_sheet_title_color: e.target.value || null }
                                  : null
                              )
                            }
                            className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
                          />
                        </div>
                      </div>
                      <div className="pt-4">
                        <label className="flex items-center gap-1.5 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={activeSheet.sub_sheet_title_bold ?? false}
                            onChange={(e) =>
                              setActiveSheet((s) =>
                                s
                                  ? { ...s, sub_sheet_title_bold: e.target.checked }
                                  : null
                              )
                            }
                            className="rounded"
                          />
                          <span className="text-xs text-neutral-300 font-bold">B</span>
                        </label>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          )}

          {/* Auto-layout */}
          <section>
            <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
              Auto-Layout
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-neutral-400 mb-1">
                  Sticker asset
                </label>
                <select
                  value={layoutAssetId}
                  onChange={(e) => setLayoutAssetId(e.target.value)}
                  className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                >
                  <option value="">Select...</option>
                  {assets.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs text-neutral-400 mb-1">
                    Quantity
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={10000}
                    value={layoutQty}
                    onChange={(e) => setLayoutQty(Number(e.target.value))}
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs text-neutral-400 mb-1">
                    Orient
                  </label>
                  <select
                    value={layoutOrientation}
                    onChange={(e) =>
                      setLayoutOrientation(
                        e.target.value as "auto" | "horizontal" | "vertical"
                      )
                    }
                    className="w-full rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
                  >
                    <option value="auto">Auto</option>
                    <option value="horizontal">Horizontal</option>
                    <option value="vertical">Vertical</option>
                  </select>
                </div>
              </div>
              <button
                onClick={handleAutoLayout}
                disabled={!layoutAssetId}
                className="w-full rounded-md bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white px-3 py-2 text-sm font-medium"
              >
                Fill Sheet
              </button>
              {layoutResult && (
                <div className="text-xs text-neutral-400 space-y-0.5">
                  <div>
                    {layoutResult.cols} cols &times; {layoutResult.rows} rows
                  </div>
                  <div>{layoutResult.zones} zone(s)</div>
                  <div>
                    Total: {(layoutResult.total_height_mm / 1000).toFixed(2)}m
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Zoom */}
          <section>
            <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
              Zoom
            </h3>
            <input
              type="range"
              min={0.2}
              max={3}
              step={0.1}
              value={zoom}
              onChange={(e) => setZoom(Number(e.target.value))}
              className="w-full"
            />
            <div className="text-xs text-neutral-500 text-center">
              {Math.round(zoom * 100)}%
            </div>
          </section>

          {/* Save preset */}
          <section>
            <h3 className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
              Save as Preset
            </h3>
            <SavePresetForm
              sheet={activeSheet}
              onSave={(p) => setPresets((prev) => [p, ...prev])}
            />
          </section>
        </div>
      </div>

      {err && (
        <div className="absolute bottom-4 left-4 bg-red-900/90 text-red-200 text-sm px-4 py-2 rounded-lg">
          {err}
          <button
            onClick={() => setErr(null)}
            className="ml-3 text-red-400 hover:text-white"
          >
            &times;
          </button>
        </div>
      )}
    </div>
  );
}

// ---------- Sub-components ----------

function SettingRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-neutral-300">{label}</span>
      {children}
    </div>
  );
}

function SavePresetForm({
  sheet,
  onSave,
}: {
  sheet: StickerSheet;
  onSave: (p: CutterPreset) => void;
}) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const p = await createPreset({
        name: name.trim(),
        media_width_mm: sheet.media_width_mm,
        registration_type: sheet.registration_type,
        max_zone_length_mm: sheet.max_zone_length_mm,
        mark_offset_mm: sheet.mark_offset_mm,
        default_gap_mm: sheet.gap_mm,
        default_edge_margin_mm: sheet.edge_margin_mm,
        show_crop_marks: sheet.show_crop_marks,
      });
      onSave(p);
      setName("");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex gap-2">
      <input
        type="text"
        placeholder="Preset name..."
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1.5 text-sm text-white"
      />
      <button
        onClick={save}
        disabled={!name.trim() || saving}
        className="rounded bg-neutral-700 hover:bg-neutral-600 disabled:opacity-40 text-white px-3 py-1.5 text-xs font-medium"
      >
        Save
      </button>
    </div>
  );
}

// ---------- Canvas helpers ----------

const SUB_SHEET_SIZES: Record<string, { w: number; h: number }> = {
  a5: { w: 148, h: 210 },
  a4: { w: 210, h: 297 },
  a3: { w: 297, h: 420 },
};

function _drawSubSheets(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  scale: number,
  sheet: StickerSheet,
  bgImage: HTMLImageElement | null
) {
  const size = SUB_SHEET_SIZES[sheet.sub_sheet_size ?? ""];
  if (!size) return;

  const subW = size.w * scale;
  const subH = size.h * scale;
  const subGap = (sheet.sub_sheet_gap_mm ?? 5) * scale;
  const edge = (sheet.edge_margin_mm ?? 5) * scale;
  const padding = (sheet.sub_sheet_padding_mm ?? 5) * scale;
  const bleed = (sheet.sub_sheet_bleed_mm ?? 0) * scale;
  const sheetW = sheet.media_width_mm * scale;
  const sheetH = sheet.media_height_mm * scale;

  const availableW = sheetW - 2 * edge;
  const cols = Math.max(1, Math.floor((availableW + subGap) / (subW + subGap)));
  const availableH = sheetH - 2 * edge;
  const rows = Math.max(1, Math.floor((availableH + subGap) / (subH + subGap)));

  const markLen = 4 * scale;
  const markOffset = 1.5 * scale;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = edge + col * (subW + subGap);
      const sy = edge + row * (subH + subGap);

      const bx = ox + sx - bleed;
      const by = oy + sy - bleed;
      const bw = subW + 2 * bleed;
      const bh = subH + 2 * bleed;

      // Background image (fills with bleed, drawn first)
      if (bgImage) {
        ctx.save();
        ctx.drawImage(bgImage, bx, by, bw, bh);
        ctx.restore();
      }

      // Fill colour/gradient background with bleed (skipped if image is set)
      if (!bgImage && (sheet.sub_sheet_fill_color || sheet.sub_sheet_fill_color2)) {
        ctx.save();

        if (sheet.sub_sheet_fill_color2 && sheet.sub_sheet_fill_color) {
          const angle = ((sheet.sub_sheet_gradient_angle ?? 135) * Math.PI) / 180;
          const cx = bx + bw / 2;
          const cy = by + bh / 2;
          const len = Math.max(bw, bh);
          const dx = Math.cos(angle) * len / 2;
          const dy = Math.sin(angle) * len / 2;
          const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
          grad.addColorStop(0, sheet.sub_sheet_fill_color);
          grad.addColorStop(1, sheet.sub_sheet_fill_color2);
          ctx.fillStyle = grad;
        } else {
          ctx.fillStyle = sheet.sub_sheet_fill_color || "#ffffff";
        }

        ctx.fillRect(bx, by, bw, bh);
        ctx.restore();
      }

      // Title at top of sub-sheet (inside padding area)
      if (sheet.sub_sheet_title) {
        const fontSize = (sheet.sub_sheet_title_size_mm ?? 5) * scale;
        const font = sheet.sub_sheet_title_font ?? "Inter";
        const bold = sheet.sub_sheet_title_bold ? "bold " : "";
        ctx.save();
        ctx.font = `${bold}${fontSize}px ${font}, sans-serif`;
        ctx.fillStyle = sheet.sub_sheet_title_color || "#000000";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(
          sheet.sub_sheet_title,
          ox + sx + subW / 2,
          oy + sy + padding * 0.2
        );
        ctx.restore();
      }

      // Sub-sheet outline (dashed)
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = "#a3a3a3";
      ctx.lineWidth = 0.75;
      ctx.strokeRect(ox + sx, oy + sy, subW, subH);
      ctx.setLineDash([]);

      // Inner padding indicator (accounts for title offset)
      const titleOffset = sheet.sub_sheet_title
        ? Math.max((sheet.sub_sheet_title_size_mm ?? 5) + 3, 3) * scale
        : 0;
      ctx.setLineDash([2, 4]);
      ctx.strokeStyle = "#525252";
      ctx.lineWidth = 0.4;
      ctx.strokeRect(
        ox + sx + padding,
        oy + sy + padding + titleOffset,
        subW - 2 * padding,
        subH - 2 * padding - titleOffset
      );
      ctx.setLineDash([]);

      // Crop marks at the 4 corners of this sub-sheet
      if (sheet.show_crop_marks) {
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 0.75;
        const corners = [
          [sx, sy],
          [sx + subW, sy],
          [sx, sy + subH],
          [sx + subW, sy + subH],
        ];
        for (const [cx, cy] of corners) {
          const hDir = cx === sx ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(ox + cx + hDir * markOffset, oy + cy);
          ctx.lineTo(ox + cx + hDir * (markOffset + markLen), oy + cy);
          ctx.stroke();
          const vDir = cy === sy ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(ox + cx, oy + cy + vDir * markOffset);
          ctx.lineTo(ox + cx, oy + cy + vDir * (markOffset + markLen));
          ctx.stroke();
        }
      }
    }
  }
}

function _drawSubSheetOverlay(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  scale: number,
  sheet: StickerSheet
) {
  const size = SUB_SHEET_SIZES[sheet.sub_sheet_size ?? ""];
  if (!size) return;

  const subW = size.w * scale;
  const subH = size.h * scale;
  const subGap = (sheet.sub_sheet_gap_mm ?? 5) * scale;
  const edge = (sheet.edge_margin_mm ?? 5) * scale;
  const sheetW = sheet.media_width_mm * scale;
  const sheetH = sheet.media_height_mm * scale;

  const availableW = sheetW - 2 * edge;
  const cols = Math.max(1, Math.floor((availableW + subGap) / (subW + subGap)));
  const availableH = sheetH - 2 * edge;
  const rows = Math.max(1, Math.floor((availableH + subGap) / (subH + subGap)));

  const markLen = 4 * scale;
  const markOffset = 1.5 * scale;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sx = edge + col * (subW + subGap);
      const sy = edge + row * (subH + subGap);

      // Solid border on top of stickers
      ctx.strokeStyle = "#6366f1";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(ox + sx, oy + sy, subW, subH);

      // Crop marks at corners (drawn on top)
      if (sheet.show_crop_marks) {
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = 1;
        const corners = [
          [sx, sy],
          [sx + subW, sy],
          [sx, sy + subH],
          [sx + subW, sy + subH],
        ];
        for (const [cx, cy] of corners) {
          const hDir = cx === sx ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(ox + cx + hDir * markOffset, oy + cy);
          ctx.lineTo(ox + cx + hDir * (markOffset + markLen), oy + cy);
          ctx.stroke();
          const vDir = cy === sy ? -1 : 1;
          ctx.beginPath();
          ctx.moveTo(ox + cx, oy + cy + vDir * markOffset);
          ctx.lineTo(ox + cx, oy + cy + vDir * (markOffset + markLen));
          ctx.stroke();
        }
      }
    }
  }
}

function _drawRulers(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  _w: number,
  _h: number,
  scale: number,
  sheet: StickerSheet
) {
  ctx.fillStyle = "#27272a";
  ctx.fillRect(0, 0, ctx.canvas.width, oy - 4);
  ctx.fillRect(0, 0, ox - 4, ctx.canvas.height);

  ctx.font = "9px monospace";
  ctx.fillStyle = "#71717a";
  ctx.textAlign = "center";

  const stepMm = scale > 1.5 ? 10 : scale > 0.8 ? 50 : 100;

  // Horizontal ruler
  for (let mm = 0; mm <= sheet.media_width_mm; mm += stepMm) {
    const x = ox + mm * (scale / MM_TO_PX) * MM_TO_PX;
    if (x > ctx.canvas.width) break;
    ctx.fillText(String(mm), x, oy - 8);
    ctx.beginPath();
    ctx.moveTo(x, oy - 4);
    ctx.lineTo(x, oy);
    ctx.strokeStyle = "#52525b";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // Vertical ruler
  ctx.textAlign = "right";
  for (let mm = 0; mm <= sheet.media_height_mm; mm += stepMm) {
    const y = oy + mm * (scale / MM_TO_PX) * MM_TO_PX;
    if (y > ctx.canvas.height) break;
    ctx.fillText(String(mm), ox - 8, y + 3);
    ctx.beginPath();
    ctx.moveTo(ox - 4, y);
    ctx.lineTo(ox, y);
    ctx.strokeStyle = "#52525b";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }
}

function _drawRegMarksPreview(
  ctx: CanvasRenderingContext2D,
  ox: number,
  oy: number,
  _w: number,
  _h: number,
  scale: number,
  sheet: StickerSheet
) {
  const markOffset = sheet.mark_offset_mm * (scale / MM_TO_PX) * MM_TO_PX;
  const w = sheet.media_width_mm * (scale / MM_TO_PX) * MM_TO_PX;
  const h = sheet.media_height_mm * (scale / MM_TO_PX) * MM_TO_PX;

  if (sheet.registration_type === "summa_opos" && sheet.max_zone_length_mm) {
    const zoneH =
      sheet.max_zone_length_mm * (scale / MM_TO_PX) * MM_TO_PX;
    const numMarks = Math.ceil(h / zoneH) + 1;
    ctx.fillStyle = "#ef4444";
    for (let i = 0; i < numMarks; i++) {
      const y = Math.min(i * zoneH, h);
      for (const x of [markOffset, w - markOffset]) {
        ctx.beginPath();
        ctx.arc(ox + x, oy + y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  } else if (sheet.registration_type === "velloblade") {
    ctx.fillStyle = "#f59e0b";
    const corners = [
      [markOffset, markOffset],
      [w - markOffset, markOffset],
      [markOffset, h - markOffset],
      [w - markOffset, h - markOffset],
    ];
    for (const [x, y] of corners) {
      ctx.beginPath();
      ctx.arc(ox + x, oy + y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
