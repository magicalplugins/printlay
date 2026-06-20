import { useCallback, useEffect, useRef, useState } from "react";
import DtfCanvas, { DtfItem, getEffectiveDpi } from "../components/app/DtfCanvas";
import {
  createFreeSession,
  deleteFreeSession,
  exportFreePdf,
  FreeAsset,
  FreePlacement,
  uploadFreeAsset,
} from "../api/freeTools";

const SHEET_WIDTH_MM = 700;
const SHEET_HEIGHT_MM = 1000;
const EDGE_MARGIN_MM = 10;
const GAP_MM = 5;
const MAX_FILES = 5;
const MM_PER_PT = 25.4 / 72;

export default function FreeSheetTool() {
  const [token, setToken] = useState<string | null>(null);
  const [assets, setAssets] = useState<FreeAsset[]>([]);
  const [items, setItems] = useState<DtfItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const initRef = useRef(false);

  // Create session on mount
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;
    createFreeSession().then(setToken).catch(() => setErr("Failed to create session"));
    return () => {
      // Cleanup on unmount
      if (token) deleteFreeSession(token).catch(() => {});
    };
  }, []);

  // Place artwork avoiding overlap
  const addArtwork = useCallback(
    (asset: FreeAsset, existingItems: DtfItem[]) => {
      const w = asset.width_pt * MM_PER_PT;
      const h = asset.height_pt * MM_PER_PT;
      const margin = EDGE_MARGIN_MM;
      const usableW = SHEET_WIDTH_MM - margin * 2;

      let cursorX = margin;
      let cursorY = margin;

      // Find the lowest existing item to start below
      for (const it of existingItems) {
        const bottom = it.y_mm + it.h_mm + GAP_MM;
        if (bottom > cursorY) {
          cursorY = bottom;
        }
      }
      // Try to fit on the same row as last item
      if (existingItems.length > 0) {
        const lastItem = existingItems[existingItems.length - 1];
        const rightEdge = lastItem.x_mm + lastItem.w_mm + GAP_MM;
        if (rightEdge + w <= usableW + margin) {
          cursorX = rightEdge;
          cursorY = lastItem.y_mm;
        }
      }

      if (cursorX + w > usableW + margin) {
        cursorX = margin;
      }

      if (cursorY + h > SHEET_HEIGHT_MM - margin) {
        setErr("No room on sheet — remove an artwork first");
        return null;
      }

      const item: DtfItem = {
        id: `${asset.id}-${Date.now()}`,
        asset: asset as any,
        x_mm: cursorX,
        y_mm: cursorY,
        w_mm: w,
        h_mm: h,
        rotation_deg: 0,
      };
      return item;
    },
    []
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!token) return;

      const files = Array.from(e.dataTransfer.files).filter(
        (f) =>
          f.type.startsWith("image/") ||
          f.name.endsWith(".pdf") ||
          /\.(png|jpe?g|gif|webp|svg)$/i.test(f.name)
      );
      if (files.length === 0) return;

      const remaining = MAX_FILES - assets.length;
      if (remaining <= 0) {
        setErr(`Maximum ${MAX_FILES} artworks. Download your sheet to start fresh.`);
        return;
      }
      const toUpload = files.slice(0, remaining);
      if (files.length > remaining) {
        setErr(`Only uploading ${remaining} of ${files.length} files (max ${MAX_FILES} total)`);
      }

      setUploading(true);
      setErr(null);
      let currentItems = [...items];

      for (const file of toUpload) {
        try {
          const asset = await uploadFreeAsset(token, file);
          setAssets((prev) => [...prev, asset]);
          const newItem = addArtwork(asset, currentItems);
          if (newItem) {
            currentItems = [...currentItems, newItem];
            setItems([...currentItems]);
          }
        } catch (e: any) {
          setErr(e.message || "Upload failed");
        }
      }
      setUploading(false);
    },
    [token, assets.length, items, addArtwork]
  );

  const handleExport = useCallback(async () => {
    if (!token || items.length === 0) return;
    setExporting(true);
    setErr(null);

    const placements: FreePlacement[] = items.map((item) => ({
      asset_id: item.asset.id,
      x_mm: Math.round(item.x_mm * 100) / 100,
      y_mm: Math.round(item.y_mm * 100) / 100,
      rotation_deg: item.rotation_deg,
      scale: item.w_mm / (item.asset.width_pt * MM_PER_PT),
    }));

    try {
      const blob = await exportFreePdf({
        token,
        sheet_width_mm: SHEET_WIDTH_MM,
        sheet_height_mm: SHEET_HEIGHT_MM,
        gap_mm: GAP_MM,
        edge_margin_mm: EDGE_MARGIN_MM,
        mirror_output: false,
        placements,
      });

      // Trigger download
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gang-sheet.pdf";
      a.click();
      URL.revokeObjectURL(url);

      // Clear everything — artwork is deleted server-side
      setItems([]);
      setAssets([]);
      setToken(null);
      // Get a fresh session
      const newToken = await createFreeSession();
      setToken(newToken);
    } catch (e: any) {
      setErr(e.message || "Export failed");
    } finally {
      setExporting(false);
    }
  }, [token, items]);

  const onMove = useCallback((id: string, x: number, y: number) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, x_mm: x, y_mm: y } : it)));
  }, []);

  const onResize = useCallback((id: string, w: number, h: number) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, w_mm: w, h_mm: h } : it)));
  }, []);

  const onRotate = useCallback((id: string, deg: number) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, rotation_deg: deg } : it)));
  }, []);

  const removeItem = useCallback((id: string) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* Header */}
      <header className="border-b border-neutral-800 px-4 sm:px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-white">Free Gang Sheet Creator</h1>
            <p className="text-sm text-neutral-400 mt-0.5">
              Arrange your artwork, download a print-ready PDF. No sign-up required.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 border border-neutral-700 rounded-lg overflow-hidden">
              <button
                onClick={() => setZoom(1)}
                className={`px-2.5 py-1.5 text-xs ${zoom === 1 ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
              >
                Fit
              </button>
              <button
                onClick={() => setZoom(2)}
                className={`px-2.5 py-1.5 text-xs ${zoom === 2 ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
              >
                2x
              </button>
              <button
                onClick={() => setZoom(3)}
                className={`px-2.5 py-1.5 text-xs ${zoom === 3 ? "bg-neutral-700 text-white" : "text-neutral-400 hover:text-white"}`}
              >
                3x
              </button>
            </div>
            <button
              onClick={handleExport}
              disabled={exporting || items.length === 0}
              className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed text-white px-4 py-2 text-sm font-medium"
            >
              {exporting ? "Exporting…" : "Download PDF"}
            </button>
          </div>
        </div>
      </header>

      {err && (
        <div className="max-w-7xl mx-auto px-4 sm:px-6 mt-3">
          <div className="bg-amber-900/30 border border-amber-700/50 rounded-lg px-4 py-2 text-sm text-amber-300">
            {err}
            <button onClick={() => setErr(null)} className="ml-3 text-amber-500 hover:text-amber-300">✕</button>
          </div>
        </div>
      )}

      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-4 flex gap-4 flex-col lg:flex-row">
        {/* Canvas area */}
        <div
          className="flex-1 min-w-0"
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <div
            className={`relative border-2 rounded-xl overflow-auto transition ${
              dragOver
                ? "border-emerald-500 bg-emerald-500/5"
                : "border-neutral-800 bg-neutral-900/50"
            }`}
            style={{ maxHeight: "75vh" }}
          >
            {uploading && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-neutral-950/60 rounded-xl">
                <div className="text-sm text-emerald-400 animate-pulse">Uploading…</div>
              </div>
            )}
            {items.length === 0 && !uploading ? (
              <div className="flex flex-col items-center justify-center py-32 text-center px-6">
                <div className="text-4xl mb-3 opacity-50">📄</div>
                <p className="text-neutral-400 text-sm">
                  Drag & drop your artwork here
                </p>
                <p className="text-neutral-600 text-xs mt-1">
                  PNG, JPG, PDF, SVG — up to {MAX_FILES} files
                </p>
              </div>
            ) : (
              <div style={{ width: `${zoom * 100}%` }}>
                <DtfCanvas
                  items={items}
                  sheetWidthMm={SHEET_WIDTH_MM}
                  sheetHeightMm={SHEET_HEIGHT_MM}
                  onMove={onMove}
                  onResize={onResize}
                  onRotate={onRotate}
                  onSelect={setSelectedId}
                  selectedId={selectedId}
                  zoom={zoom}
                />
              </div>
            )}
          </div>
        </div>

        {/* Sidebar */}
        <div className="w-full lg:w-72 shrink-0">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 space-y-4">
            <h3 className="text-xs uppercase tracking-widest text-emerald-400 font-semibold">
              Artwork ({assets.length}/{MAX_FILES})
            </h3>

            {items.length === 0 ? (
              <p className="text-xs text-neutral-500 py-4 text-center">
                Drop artwork on the canvas to get started
              </p>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {items.map((item) => {
                  const dpi = getEffectiveDpi(item);
                  const lowDpi = dpi !== null && dpi < 150;
                  return (
                    <div
                      key={item.id}
                      className={`flex items-center gap-2 p-2 rounded-lg border transition cursor-pointer ${
                        selectedId === item.id
                          ? "border-emerald-500/60 bg-emerald-500/5"
                          : "border-neutral-800 hover:border-neutral-700"
                      }`}
                      onClick={() => setSelectedId(item.id)}
                    >
                      {item.asset.thumbnail_url && (
                        <img
                          src={item.asset.thumbnail_url}
                          alt=""
                          className="w-9 h-9 rounded object-cover shrink-0 bg-neutral-800"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-neutral-200 truncate">
                          {item.asset.name}
                        </div>
                        <div className="text-[10px] text-neutral-500">
                          {Math.round(item.w_mm)}×{Math.round(item.h_mm)} mm
                          {lowDpi && (
                            <span className="ml-1.5 text-amber-400 font-medium">
                              ⚠ {dpi} DPI
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeItem(item.id); }}
                        className="text-rose-400 hover:text-rose-300 text-xs shrink-0"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="border-t border-neutral-800 pt-4 space-y-2">
              <div className="text-[10px] text-neutral-500 space-y-1">
                <p>Sheet: {SHEET_WIDTH_MM}×{SHEET_HEIGHT_MM} mm</p>
                <p>Edge margin: {EDGE_MARGIN_MM} mm</p>
                <p>Gap: {GAP_MM} mm</p>
              </div>
            </div>

            <div className="border-t border-neutral-800 pt-4">
              <p className="text-[10px] text-neutral-600 leading-relaxed">
                All artwork is deleted immediately after download. Nothing is saved.
                For multi-sheet, saving, and pricing — <a href="/app" className="text-violet-400 hover:text-violet-300 underline">sign up free</a>.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
