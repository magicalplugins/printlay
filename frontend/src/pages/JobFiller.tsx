import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  DndContext,
  DragEndEvent,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Asset,
  Category,
  getAssetPageThumbnail,
  listAssets,
  listCategories,
} from "../api/catalogue";
import {
  applyJobQueue,
  deleteJobUpload,
  exportJobSvg,
  generateOutput,
  getJob,
  Job,
  listJobUploads,
  pollOutputStatus,
  QueueItem,
  updateJob,
  uploadJobAsset,
} from "../api/jobs";
import {
  downloadTemplateUrl,
  getTemplate,
  Template,
} from "../api/templates";
import { autoReparseIfStale } from "../utils/reparseTemplate";
import { formatApiError, FormattedApiError } from "../utils/apiError";
import JobColorsPanel from "../components/app/JobColorsPanel";
import SpotColorsPanel from "../components/app/SpotColorsPanel";
import LockedOverlay, { useIsLocked } from "../components/app/LockedOverlay";
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import PdfCanvas from "../components/app/PdfCanvas";
import SlotOverlay, {
  SlotPlacement as OverlayPlacement,
} from "../components/app/SlotOverlay";
import SlotDesigner, {
  SlotPlacement as DesignerPlacement,
} from "../components/app/SlotDesigner";

const PT_PER_MM = 72.0 / 25.4;

type QueueRow = {
  /** Stable client-side key (UUID v4-ish, generated locally). */
  key: string;
  asset: Asset;
  qty: number;
  rotationDeg: number;
  fitMode: "contain" | "cover" | "stretch" | "manual";
  xMm: number;
  yMm: number;
  wMm: number | null;
  hMm: number | null;
  filterId: string;
  /** Non-destructive "safe crop" frame. When true, the printable area
   *  shrinks from slot+bleed down to slot-safe and everything outside
   *  the safe rect is rendered as a uniform white border (in both the
   *  preview and the generated PDF). Doesn't touch the placement
   *  coords above — the user can flip it off and keep editing. */
  safeCrop: boolean;
  /** Which page/artboard of the source PDF to render. 0 for single-page
   *  assets. Multi-page PDFs (e.g. double-sided sticker artwork) can
   *  set this per row so different slots show different sides. */
  pageIndex: number;
};

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function sameTransform(a: QueueRow, asg: NonNullable<Job["assignments"][string]>): boolean {
  const rot = ((asg.rotation_deg || 0) % 360 + 360) % 360;
  if (a.rotationDeg !== rot) return false;
  if (a.fitMode !== (asg.fit_mode || "contain")) return false;
  if ((a.filterId || "none") !== (asg.filter_id || "none")) return false;
  if (Boolean(a.safeCrop) !== Boolean(asg.safe_crop)) return false;
  if ((a.pageIndex || 0) !== (asg.page_index || 0)) return false;
  if (a.fitMode === "manual") {
    return (
      a.xMm === (asg.x_mm || 0) &&
      a.yMm === (asg.y_mm || 0) &&
      a.wMm === (asg.w_mm ?? null) &&
      a.hMm === (asg.h_mm ?? null)
    );
  }
  return true;
}

function rowsFromJob(job: Job, assets: Asset[]): QueueRow[] {
  // Reconstruct a queue from the job's existing assignments by walking
  // slot_order and grouping consecutive slots that share the same asset
  // AND the same transform (different transforms of the same asset are
  // separate queue rows).
  const byId = new Map(assets.map((a) => [a.id, a]));
  const rows: QueueRow[] = [];
  for (const slotIdx of job.slot_order) {
    const a = job.assignments[String(slotIdx)];
    if (!a) continue;
    const asset = byId.get(a.asset_id);
    if (!asset) continue;
    const last = rows[rows.length - 1];
    if (last && last.asset.id === a.asset_id && sameTransform(last, a)) {
      last.qty += 1;
    } else {
      rows.push({
        key: uid(),
        asset,
        qty: 1,
        rotationDeg: ((a.rotation_deg || 0) % 360 + 360) % 360,
        fitMode: (a.fit_mode as QueueRow["fitMode"]) || "contain",
        xMm: a.x_mm || 0,
        yMm: a.y_mm || 0,
        wMm: a.w_mm ?? null,
        hMm: a.h_mm ?? null,
        filterId: a.filter_id || "none",
        safeCrop: Boolean(a.safe_crop),
        pageIndex: a.page_index || 0,
      });
    }
  }
  return rows;
}

// ─── Expand icon (diagonal double-arrow) ──────────────────────────────────────
function ExpandIcon({ shrink = false }: { shrink?: boolean }) {
  return shrink ? (
    // Arrows pointing inward from top-right and bottom-left (collapse)
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M9 1h4v4M5 13H1V9M13 1l-5 5M1 13l5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  ) : (
    // Arrows pointing outward toward top-right and bottom-left (expand)
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path d="M9 1h4v4M5 13H1V9M8 6l5-5M6 8l-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
  );
}

// ─── Shared catalogue picker UI ───────────────────────────────────────────────
function CataloguePicker({
  activeCat, setActiveCat,
  catSearch, setCatSearch,
  assetSearch, setAssetSearch,
  cats, filteredCats,
  catAssets, filteredCatAssets,
  expanded, onExpand, onCollapse, addRow,
  gridCols, maxH,
}: {
  activeCat: import("../api/catalogue").Category | null;
  setActiveCat: (c: import("../api/catalogue").Category | null) => void;
  catSearch: string;
  setCatSearch: (v: string) => void;
  assetSearch: string;
  setAssetSearch: (v: string) => void;
  cats: import("../api/catalogue").Category[] | null;
  filteredCats: import("../api/catalogue").Category[];
  catAssets: import("../api/catalogue").Asset[] | null;
  filteredCatAssets: import("../api/catalogue").Asset[] | null;
  expanded: boolean;
  onExpand: () => void;
  onCollapse?: () => void;
  addRow: (a: import("../api/catalogue").Asset, n: number) => void;
  gridCols: string;
  maxH: string;
}) {
  // iOS Safari zooms in on focus when font-size < 16px — prevent that
  const inputStyle: React.CSSProperties = { fontSize: 16 };

  return !activeCat ? (
    <>
      <div className={`flex gap-2 ${expanded ? "px-1 py-1" : ""}`}>
        <input
          type="search"
          value={catSearch}
          onChange={(e) => setCatSearch(e.target.value)}
          placeholder="Search categories…"
          style={inputStyle}
          className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
        />
        {!expanded ? (
          <button
            onClick={onExpand}
            className="shrink-0 rounded-md border border-neutral-700 bg-neutral-900 px-2.5 py-2 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition"
            title="Expand to full screen"
          >
            <ExpandIcon />
          </button>
        ) : (
          <button
            onClick={onCollapse}
            className="shrink-0 flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-2 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-700 active:scale-95 transition-all whitespace-nowrap"
            title="Exit full screen"
          >
            <ExpandIcon shrink />
            <span>Exit full screen</span>
          </button>
        )}
      </div>
      {cats === null ? (
        <div className="text-xs text-neutral-500">Loading…</div>
      ) : cats.length === 0 ? (
        <a href="/app/catalogue" className="block text-sm text-neutral-400 underline">
          No categories yet — create some →
        </a>
      ) : filteredCats.length === 0 ? (
        <div className="text-xs text-neutral-500">
          No categories match "{catSearch}".
        </div>
      ) : (
        <ul className={`overflow-y-auto divide-y divide-neutral-800/60 rounded-lg border border-neutral-800 ${expanded ? "max-h-none" : "max-h-64"}`}>
          {filteredCats.map((c) => (
            <li key={c.id}>
              <button
                onClick={() => setActiveCat(c)}
                className="w-full text-left px-3 py-2 text-sm text-neutral-200 hover:bg-neutral-800/60 flex items-center justify-between group"
              >
                <span>{c.name}</span>
                <span className="text-neutral-600 group-hover:text-neutral-300">→</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  ) : (
    <>
      <div className={`flex items-center justify-between text-sm ${expanded ? "px-1 py-1" : ""}`}>
        <button
          onClick={() => setActiveCat(null)}
          className="text-neutral-400 hover:text-white"
        >
          ← Categories
        </button>
        <div className="flex items-center gap-2">
          <span className="text-neutral-500 text-xs truncate max-w-[120px]">{activeCat.name}</span>
          {!expanded ? (
            <button
              onClick={onExpand}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 transition"
              title="Expand to full screen"
            >
              <ExpandIcon />
            </button>
          ) : (
            <button
              onClick={onCollapse}
              className="flex items-center gap-1.5 rounded-lg border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-xs text-neutral-200 hover:border-neutral-500 hover:bg-neutral-700 active:scale-95 transition-all whitespace-nowrap"
              title="Exit full screen"
            >
              <ExpandIcon shrink />
              <span>Exit full screen</span>
            </button>
          )}
        </div>
      </div>
      {catAssets === null ? (
        <div className="text-xs text-neutral-500">Loading…</div>
      ) : catAssets.length === 0 ? (
        <div className="text-xs text-neutral-500">Empty category.</div>
      ) : (
        <>
          {catAssets.length > 5 && (
            <div className={expanded ? "px-1" : ""}>
              <input
                type="search"
                value={assetSearch}
                onChange={(e) => setAssetSearch(e.target.value)}
                placeholder="Search assets…"
                style={inputStyle}
                className="w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-600"
              />
            </div>
          )}
          {filteredCatAssets && filteredCatAssets.length > 0 ? (
            <div
              className={`overflow-y-auto ${maxH}`}
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              <div className={`grid ${gridCols} gap-2 ${expanded ? "px-1 pb-4" : ""}`}>
                {filteredCatAssets.map((a) => (
                  <button
                    key={a.id}
                    onClick={() => addRow(a, 1)}
                    className="rounded-lg border border-neutral-800 bg-white overflow-hidden ring-1 ring-black/5 shadow-sm hover:border-violet-500 active:border-violet-500 active:scale-95 transition-all group relative"
                    title={`Add ${a.name} to queue`}
                    style={{
                      height: expanded ? 120 : 90,
                      touchAction: "manipulation",
                      WebkitTapHighlightColor: "transparent",
                    }}
                  >
                    {a.preview_url || a.thumbnail_url ? (
                      <img
                        src={a.preview_url ?? a.thumbnail_url ?? ""}
                        alt={a.name}
                        className="w-full h-full object-contain p-1.5"
                        draggable={false}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-neutral-400 uppercase">
                        {a.kind}
                      </div>
                    )}
                    <div className="absolute inset-0 bg-violet-500/0 group-hover:bg-violet-500/15 active:bg-violet-500/20 transition" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="text-xs text-neutral-500">
              No assets matching "{assetSearch.trim()}"
            </div>
          )}
        </>
      )}
    </>
  );
}

export default function JobFiller() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const locked = useIsLocked();

  const [job, setJob] = useState<Job | null>(null);
  const [tpl, setTpl] = useState<Template | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [render, setRender] = useState<{ scale: number; pageWidth: number; pageHeight: number } | null>(null);

  const [rows, setRows] = useState<QueueRow[]>([]);
  const [uploadOpen, setUploadOpen] = useState(true);
  const [catOpen, setCatOpen] = useState(false);
  const [catExpanded, setCatExpanded] = useState(false);
  const [cats, setCats] = useState<Category[] | null>(null);
  const [activeCat, setActiveCat] = useState<Category | null>(null);
  const [catAssets, setCatAssets] = useState<Asset[] | null>(null);
  const [catSearch, setCatSearch] = useState("");
  const [assetSearch, setAssetSearch] = useState("");

  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [exportingSvg, setExportingSvg] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));
  const [savedHint, setSavedHint] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [designerForKey, setDesignerForKey] = useState<string | null>(null);

  // Track unsaved changes so we can warn before navigation and auto-save.
  const [dirty, setDirty] = useState(false);
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Warn user before closing/navigating away with unsaved changes.
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // Auto-save 5 seconds after last change (debounced).
  const triggerAutoSave = useCallback(() => {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      if (!job) return;
      try {
        const queue: QueueItem[] = rows.map((r) => ({
          asset_id: r.asset.id,
          quantity: r.qty,
          rotation_deg: r.rotationDeg,
          fit_mode: r.fitMode,
          x_mm: r.xMm,
          y_mm: r.yMm,
          w_mm: r.wMm,
          h_mm: r.hMm,
          filter_id: r.filterId || "none",
          safe_crop: r.safeCrop,
          page_index: r.pageIndex || 0,
        }));
        const result = await applyJobQueue(job.id, queue);
        if (result._warning) {
          setErr({ message: result._warning, suggestsUpgrade: false });
        }
        setJob(result);
        setDirty(false);
      } catch {
        // Silent fail for auto-save — user can still manually save.
      }
    }, 5000);
  }, [job, rows]);

  useEffect(() => {
    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, []);
  // Bidirectional "find me" link between the layout preview (left) and
  // the queue rows (right). When set, the matching queue row gets a
  // violet ring + scrolls into view, AND the matching slot in the
  // overlay gets a pulsing violet ring. Toggling the same target off
  // is the way to clear it - no separate "deselect" affordance needed.
  const [highlightedKey, setHighlightedKey] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // Per-generation cut-line opt-in (lifted from SpotColorsPanel so it
  // can also be reflected in the Generate button label and threaded
  // into the generateOutput call). Resets to OFF on every page load -
  // we don't auto-enable across sessions because turning it on adds a
  // visible cutter path and we want that to be a deliberate per-job
  // choice, not a persistent surprise.
  const [includeCutLines, setIncludeCutLines] = useState(false);
  // Cut-line + registration-mark spot colours, in the Sheet-Builder picker
  // form (a spot name like "CutContour" or a #hex). The registration mark
  // TYPE is baked into the template; here we only choose colours.
  const [cutLineSpot, setCutLineSpot] = useState<string>("CutContour");
  const [markSpot, setMarkSpot] = useState<string>("#000000");

  const totalSlots = job?.slot_order.length ?? 0;
  const queuedQty = rows.reduce((s, r) => s + r.qty, 0);
  const remaining = totalSlots - queuedQty;

  useEffect(() => {
    if (!id) return;
    (async () => {
      try {
        const j = await getJob(id);
        setJob(j);
        const [tRaw, d, uploads] = await Promise.all([
          getTemplate(j.template_id),
          downloadTemplateUrl(j.template_id),
          listJobUploads(j.id),
        ]);
        // Transparently re-extract slot bboxes for legacy uploaded
        // templates so the designer overlays line up with the cut
        // lines instead of the old stroke-padded bboxes.
        const t = await autoReparseIfStale(tRaw);
        setTpl(t);
        setPdfUrl(d.url);
        // Hydrate the queue: we need ALL assets referenced in current job
        // assignments. Job uploads cover ephemeral; for catalogue assets
        // already assigned, we don't have them yet—fetch lazily as needed.
        const assignedIds = new Set(
          Object.values(j.assignments).map((a) => a.asset_id)
        );
        const knownIds = new Set(uploads.map((a) => a.id));
        const missing = [...assignedIds].filter((aid) => !knownIds.has(aid));
        let known: Asset[] = [...uploads];
        if (missing.length > 0) {
          // Pull catalogue assets via category listing; cheaper than per-asset.
          const cs = await listCategories();
          const allCatAssets = (
            await Promise.all(cs.map((c) => listAssets(c.id)))
          ).flat();
          known = [
            ...known,
            ...allCatAssets.filter((a) => missing.includes(a.id)),
          ];
        }
        setRows(rowsFromJob(j, known));
      } catch (e) {
        reportErr(e);
      }
    })();
  }, [id]);

  useEffect(() => {
    if (!catOpen || cats !== null) return;
    listCategories().then(setCats).catch((e) => reportErr(e));
  }, [catOpen, cats]);

  useEffect(() => {
    if (!activeCat) {
      setCatAssets(null);
      setAssetSearch("");
      return;
    }
    setAssetSearch("");
    listAssets(activeCat.id).then(setCatAssets).catch((e) => reportErr(e));
  }, [activeCat]);

  // Resolve per-page thumbnail URLs for every row that has selected a
  // non-default page on a multi-page asset. Without this, the live preview
  // would always show page 0's thumbnail even after the user picks page 2
  // in the PagePicker (the final exported PDF already uses the correct
  // page, this only affects on-screen feedback). We dedupe by
  // (assetId, pageIndex) so multiple rows on the same page share one fetch.
  const [pagePreviewUrls, setPagePreviewUrls] = useState<
    Record<string, string>
  >({});
  useEffect(() => {
    const wanted = new Set<string>();
    for (const row of rows) {
      if (row.pageIndex > 0) wanted.add(`${row.asset.id}:${row.pageIndex}`);
    }
    if (wanted.size === 0) return;
    let cancelled = false;
    for (const key of wanted) {
      if (pagePreviewUrls[key]) continue;
      const [assetId, idxStr] = key.split(":");
      fetchPageThumb(assetId, Number(idxStr))
        .then((url) => {
          if (cancelled) return;
          setPagePreviewUrls((prev) =>
            prev[key] === url ? prev : { ...prev, [key]: url }
          );
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [rows, pagePreviewUrls]);

  // Live preview: derive a slotNumbers map AND a placement map (artwork
  // thumbnail + transform per slot) from the current queue order so the PDF
  // overlay updates as the user reorders/changes quantities/rotates/customises.
  // We also build two cross-reference maps used by the "find me" highlight:
  //   - slotToRowKey: clicking a slot in the preview tells us which queue
  //     row owns it.
  //   - rowKeyToFirstSlot: clicking a queue row tells us which slot in the
  //     preview to ring (we pick the first occurrence so the user always
  //     sees the lowest-numbered position for that artwork).
  const {
    previewSlotMap,
    previewPlacements,
    slotToRowKey,
    rowKeyToFirstSlot,
  } = useMemo(() => {
    const nums: Record<number, number> = {};
    const placements: Record<number, OverlayPlacement> = {};
    const slotToRow: Record<number, string> = {};
    const rowToSlot: Record<string, number> = {};
    if (!job)
      return {
        previewSlotMap: nums,
        previewPlacements: placements,
        slotToRowKey: slotToRow,
        rowKeyToFirstSlot: rowToSlot,
      };
    let cursor = 0;
    let n = 1;
    for (const row of rows) {
      for (let i = 0; i < row.qty; i++) {
        if (cursor >= job.slot_order.length) {
          return {
            previewSlotMap: nums,
            previewPlacements: placements,
            slotToRowKey: slotToRow,
            rowKeyToFirstSlot: rowToSlot,
          };
        }
        const slotIdx = job.slot_order[cursor];
        nums[slotIdx] = n++;
        const pageUrl =
          row.pageIndex > 0
            ? pagePreviewUrls[`${row.asset.id}:${row.pageIndex}`]
            : undefined;
        placements[slotIdx] = {
          thumbnailUrl:
            pageUrl ?? row.asset.preview_url ?? row.asset.thumbnail_url ?? null,
          rotationDeg: row.rotationDeg,
          fitMode: row.fitMode,
          xMm: row.xMm,
          yMm: row.yMm,
          wMm: row.wMm,
          hMm: row.hMm,
          filterId: row.filterId,
          safeCrop: row.safeCrop,
          assetNaturalWmm: row.asset.width_pt
            ? row.asset.width_pt / PT_PER_MM
            : undefined,
          assetNaturalHmm: row.asset.height_pt
            ? row.asset.height_pt / PT_PER_MM
            : undefined,
        };
        slotToRow[slotIdx] = row.key;
        if (rowToSlot[row.key] === undefined) rowToSlot[row.key] = slotIdx;
        cursor++;
      }
    }
    return {
      previewSlotMap: nums,
      previewPlacements: placements,
      slotToRowKey: slotToRow,
      rowKeyToFirstSlot: rowToSlot,
    };
  }, [rows, job, pagePreviewUrls]);

  // Derive the slot to ring from the currently-highlighted row key. If
  // the highlighted row no longer exists (deleted) or no longer maps to
  // any slot (qty zero, off the end), the ring just disappears - no
  // dangling state to clean up.
  const highlightedSlotIdx =
    highlightedKey != null ? rowKeyToFirstSlot[highlightedKey] ?? null : null;

  // When the highlight target changes, scroll the matching row into view
  // in the queue (covers the desktop case where the queue extends below
  // the fold) and the preview into view (covers the mobile case where
  // the preview is stacked above the queue and may be off-screen). Both
  // calls no-op when the element is already visible, so it's safe to do
  // both unconditionally.
  useEffect(() => {
    if (!highlightedKey) return;
    const row = document.querySelector(
      `[data-queue-row-key="${highlightedKey}"]`
    );
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [highlightedKey]);

  function toggleHighlightFromSlot(slotIdx: number) {
    const key = slotToRowKey[slotIdx];
    if (!key) return; // empty slot - nothing to highlight
    setHighlightedKey((prev) => (prev === key ? null : key));
  }

  function toggleHighlightFromRow(rowKey: string) {
    const willHighlight = highlightedKey !== rowKey;
    setHighlightedKey(willHighlight ? rowKey : null);
    // When activating from the queue side, also scroll the preview into
    // view so the user can actually see the slot ring (mobile mostly).
    if (willHighlight) {
      previewRef.current?.scrollIntoView({
        block: "nearest",
        behavior: "smooth",
      });
    }
  }

  function addRow(asset: Asset, qty = 1) {
    setRows((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.asset.id === asset.id &&
        last.rotationDeg === 0 &&
        last.fitMode === "contain"
      ) {
        return prev.map((r, i) =>
          i === prev.length - 1 ? { ...r, qty: r.qty + qty } : r
        );
      }
      return [
        ...prev,
        {
          key: uid(),
          asset,
          qty,
          rotationDeg: 0,
          fitMode: "contain",
          xMm: 0,
          yMm: 0,
          wMm: null,
          hMm: null,
          filterId: "none",
          safeCrop: false,
          pageIndex: 0,
        },
      ];
    });
    setDirty(true);
    triggerAutoSave();
  }

  function updateQty(key: string, qty: number) {
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, qty: Math.max(1, qty) } : r))
    );
    setDirty(true);
    triggerAutoSave();
  }

  function rotateRow(key: string) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key ? { ...r, rotationDeg: (r.rotationDeg + 90) % 360 } : r
      )
    );
    setDirty(true);
    triggerAutoSave();
  }

  function setRowPage(key: string, pageIndex: number) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key ? { ...r, pageIndex: Math.max(0, pageIndex) } : r
      )
    );
    setDirty(true);
    triggerAutoSave();
  }

  function applyDesignerToRow(key: string, p: DesignerPlacement) {
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? {
              ...r,
              rotationDeg: ((p.rotation_deg % 360) + 360) % 360,
              fitMode: p.fit_mode,
              xMm: p.x_mm,
              yMm: p.y_mm,
              wMm: p.w_mm,
              hMm: p.h_mm,
              filterId: p.filter_id || "none",
              safeCrop: Boolean(p.safe_crop),
            }
          : r
      )
    );
    setDirty(true);
    triggerAutoSave();
  }

  function removeRow(key: string) {
    setRows((prev) => prev.filter((r) => r.key !== key));
    setDirty(true);
    triggerAutoSave();
  }

  async function removeRowAndAsset(row: QueueRow) {
    removeRow(row.key);
    if (row.asset.job_id && id) {
      try {
        await deleteJobUpload(id, row.asset.id);
      } catch {
        // Non-fatal. Server-side it'll be cleaned when the job is deleted.
      }
    }
  }

  // iPad/touch: long-press to start dragging (so single-finger scroll still works
  // when the queue overflows). Mouse: tiny distance gate to avoid stealing clicks.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 180, tolerance: 8 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    setRows((items) => {
      const from = items.findIndex((r) => r.key === active.id);
      const to = items.findIndex((r) => r.key === over.id);
      if (from < 0 || to < 0) return items;
      return arrayMove(items, from, to);
    });
    setDirty(true);
    triggerAutoSave();
  }

  async function onFiles(files: FileList | File[]) {
    if (!id) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      for (const f of list) {
        const asset = await uploadJobAsset(id, f);
        addRow(asset, 1);
      }
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function saveQueue(): Promise<Job | null> {
    if (!job) return null;
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    const queue: QueueItem[] = rows.map((r) => ({
      asset_id: r.asset.id,
      quantity: r.qty,
      rotation_deg: r.rotationDeg,
      fit_mode: r.fitMode,
      x_mm: r.xMm,
      y_mm: r.yMm,
      w_mm: r.wMm,
      h_mm: r.hMm,
      filter_id: r.filterId || "none",
      safe_crop: r.safeCrop,
      page_index: r.pageIndex || 0,
    }));
    const result = await applyJobQueue(job.id, queue);
    if (result._warning) {
      setErr({
        message: result._warning,
        suggestsUpgrade: false,
      });
    }
    setJob(result);
    setDirty(false);
    return result;
  }

  async function onSaveDraft() {
    setBusy(true);
    setErr(null);
    try {
      await saveQueue();
      setSavedHint(true);
      setTimeout(() => setSavedHint(false), 1800);
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
    }
  }

  async function onGenerate() {
    if (!job) return;
    setGenerating(true);
    setErr(null);
    try {
      await saveQueue();
      const out = await generateOutput(job.id, {
        include_cut_lines: includeCutLines,
        cut_line_spot_color: includeCutLines ? cutLineSpot : null,
        mark_spot_color: markSpot,
      });

      if (out.status === "processing") {
        // Heavy job — poll until ready
        const pollInterval = 3000;
        const maxAttempts = 200; // 10 minutes max
        let attempts = 0;
        const poll = async (): Promise<typeof out> => {
          attempts++;
          if (attempts > maxAttempts) {
            throw new Error("PDF generation is taking longer than expected. Check your outputs page in a few minutes.");
          }
          await new Promise((r) => setTimeout(r, pollInterval));
          const status = await pollOutputStatus(out.id);
          if (status.status === "processing") return poll();
          if (status.status === "failed") {
            throw new Error("PDF generation failed. This has been logged and we'll investigate.");
          }
          return status;
        };
        const finalOut = await poll();
        navigate(`/app/outputs?highlight=${finalOut.id}`);
        return;
      }

      // Surface colour-swap results so the user knows whether their
      // configured swaps actually fired. Quiet success (no swaps, or
      // some applied) just navigates. The interesting case is "swaps
      // configured but ZERO applied" - that almost always means the
      // user typed a HEX that doesn't exactly match the artwork's
      // colour, and silently navigating away makes them think the
      // feature is broken.
      const rep = out.color_swap_report;
      if (rep && rep.swaps_applied === 0 && rep.unmatched.length > 0) {
        const msg =
          `PDF generated, but NO colour swaps were applied.\n\n` +
          `Your swap source colours weren't found in this artwork. The ` +
          `colours actually present in the PDF are:\n` +
          `  ${rep.unmatched.slice(0, 8).join(", ")}` +
          (rep.unmatched.length > 8 ? ` (+${rep.unmatched.length - 8} more)` : ``) +
          `\n\nFix: open the Colour swaps panel and click one of the ` +
          `swatches under "Detected in this job" instead of typing a ` +
          `hex value, so the source colour matches exactly.\n\n` +
          `Open the generated PDF anyway?`;
        if (!confirm(msg)) {
          return;
        }
      } else if (rep && rep.swaps_applied > 0) {
        console.info("Colour swap report", rep);
      }

      navigate(`/app/outputs?highlight=${out.id}`);
    } catch (e) {
      reportErr(e);
    } finally {
      setGenerating(false);
    }
  }

  async function onExportCutLines() {
    if (!job) return;
    setExportingSvg(true);
    setErr(null);
    try {
      await saveQueue();
      const blob = await exportJobSvg(job.id, {
        cut_color: cutLineSpot,
        mark_color: markSpot,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${job.name || "job"}-cutlines.svg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      reportErr(e);
    } finally {
      setExportingSvg(false);
    }
  }

  async function onClearQueue() {
    if (rows.length === 0) return;
    if (!confirm("Clear the queue and remove all uploaded artwork for this job?")) return;
    if (!id) return;
    setBusy(true);
    try {
      // Delete any ephemeral uploads server-side
      for (const r of rows) {
        if (r.asset.job_id) {
          try {
            await deleteJobUpload(id, r.asset.id);
          } catch {}
        }
      }
      setRows([]);
      const updated = await updateJob(id, { assignments: {} });
      setJob(updated);
    } finally {
      setBusy(false);
    }
  }

  const filteredCatAssets = useMemo(() => {
    if (!catAssets) return null;
    const q = assetSearch.trim().toLowerCase();
    if (!q) return catAssets;
    const words = q.split(/\s+/);
    return catAssets.filter((a) => {
      const name = a.name.toLowerCase();
      return words.every((w) => name.includes(w));
    });
  }, [catAssets, assetSearch]);

  if (err && !job)
    return (
      <div className="p-8">
        <QuotaErrorBanner error={err} />
      </div>
    );
  if (!job || !tpl || !pdfUrl)
    return <div className="p-8 text-neutral-500">Loading…</div>;

  const filteredCats = (cats ?? []).filter((c) =>
    c.name.toLowerCase().includes(catSearch.trim().toLowerCase())
  );

  return (
    // overflow-x-hidden + max-w-full are defensive: if any descendant is
    // momentarily wider than the viewport (canvas before measurement, a
    // long asset name, dnd-kit ghost, etc.) the page itself stays inside
    // the viewport so iOS Safari never triggers shrink-to-fit. Scoped to
    // this wrapper (NOT html/body) so pinch-zoom still works as an
    // escape valve.
    <div className="max-w-[1600px] mx-auto px-2 sm:px-6 py-3 sm:py-8 pb-40 sm:pb-8 overflow-x-hidden">
      <div className="flex items-start justify-between mb-4 sm:mb-6 gap-3 sm:gap-6 flex-wrap min-w-0">
        <div className="min-w-0">
          <Link to="/app/jobs" className="text-sm text-neutral-400 hover:text-white">
            ← Jobs
          </Link>
          <h1 className="text-xl sm:text-3xl font-bold tracking-tight mt-2 truncate">{job.name}</h1>
          <p className="hidden sm:block text-neutral-400 text-sm mt-1">
            Build your print queue: upload artwork or pick from your catalogue,
            set how many copies of each, and drag to reorder.
          </p>
        </div>
        {/* Desktop / tablet action row. On mobile we mirror Save+Generate
            into a sticky bottom bar so they're always reachable while the
            user scrolls the queue. */}
        <div className="hidden sm:flex items-center gap-2">
          <Link
            to={`/app/jobs/${job.id}/program`}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600"
          >
            Re-program slots
          </Link>
          <button
            onClick={onSaveDraft}
            disabled={busy}
            className="rounded-lg border border-neutral-800 px-4 py-2 text-sm hover:border-neutral-600 disabled:opacity-40"
          >
            {savedHint ? "Saved ✓" : dirty ? "Save draft •" : "Save draft"}
          </button>
          <button
            onClick={onExportCutLines}
            disabled={exportingSvg || queuedQty === 0}
            className="rounded-lg bg-sky-600 hover:bg-sky-500 disabled:opacity-40 text-white px-4 py-2 text-sm font-medium"
            title="Export an SVG of just the cut lines + registration marks (for the cutter)"
          >
            {exportingSvg ? "Exporting…" : "Export Cut Lines"}
          </button>
          {locked ? (
            <Link
              to="/pricing"
              className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 shadow-lg shadow-violet-500/20"
            >
              Subscribe to generate PDF →
            </Link>
          ) : (
            <button
              onClick={onGenerate}
              disabled={generating || queuedQty === 0}
              className="rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 px-5 py-2.5 font-semibold text-white hover:from-violet-400 hover:to-fuchsia-400 disabled:opacity-40 shadow-lg shadow-violet-500/20"
              title={
                includeCutLines
                  ? "Generate with cut lines embedded for print/cut RIP"
                  : "Generate artwork-only PDF"
              }
            >
              {generating
                ? "Generating…"
                : includeCutLines
                ? `Generate PDF + cut →`
                : `Generate PDF →`}
            </button>
          )}
        </div>
      </div>

      {err && (
        <div className="mb-4">
          <QuotaErrorBanner error={err} />
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] lg:grid-cols-[minmax(0,1fr)_400px] gap-4 sm:gap-6 items-start min-w-0">
        <div className="space-y-2 min-w-0 max-w-full">
          <div className="flex items-center gap-2 text-[11px] text-neutral-500 flex-wrap">
            <span className="uppercase tracking-widest">Template</span>
            {tpl.bleed_mm > 0 ? (
              <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-rose-300">
                <span className="inline-block w-2 h-0.5 bg-rose-400" />
                Bleed {tpl.bleed_mm}mm
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-neutral-800 px-2 py-0.5 text-neutral-500">
                No bleed
                <Link
                  to={`/app/templates/${tpl.id}`}
                  className="text-violet-400 hover:text-violet-300 underline-offset-2 hover:underline ml-1"
                >
                  set
                </Link>
              </span>
            )}
            {tpl.safe_mm > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                <span className="inline-block w-2 h-0.5 bg-sky-400" />
                Safe {tpl.safe_mm}mm
              </span>
            )}
          </div>
          <div
            ref={previewRef}
            className="relative block w-full bg-white rounded-lg shadow-2xl ring-1 ring-neutral-800 overflow-hidden"
          >
            <PdfCanvas url={pdfUrl} width={900} onReady={setRender} />
            {render && (
              <SlotOverlay
                shapes={tpl.shapes}
                pageWidthPt={render.pageWidth}
                pageHeightPt={render.pageHeight}
                scale={render.scale}
                slotNumbers={previewSlotMap}
                placements={previewPlacements}
                highlightEmpty
                bleedPt={(tpl.bleed_mm || 0) * (72 / 25.4)}
                safePt={(tpl.safe_mm || 0) * (72 / 25.4)}
                onShapeClick={(s) => toggleHighlightFromSlot(s.shape_index)}
                highlightedSlotIdx={highlightedSlotIdx}
              />
            )}
          </div>
        </div>

        <aside className="space-y-4 md:sticky md:top-20 min-w-0 max-w-full">
          {/* Print queue */}
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 backdrop-blur p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <div className="text-xs uppercase tracking-widest text-neutral-500">
                  Print queue
                </div>
                <div className="text-sm text-neutral-300 mt-0.5">
                  <span
                    className={`font-mono font-semibold ${
                      queuedQty === totalSlots
                        ? "text-emerald-400"
                        : queuedQty > totalSlots
                        ? "text-rose-400"
                        : "text-violet-300"
                    }`}
                  >
                    {queuedQty}
                  </span>
                  <span className="text-neutral-500"> / {totalSlots} slots</span>
                  {remaining > 0 && (
                    <span className="text-neutral-500"> · {remaining} empty</span>
                  )}
                  {remaining < 0 && (
                    <span className="text-rose-400"> · {-remaining} over</span>
                  )}
                </div>
              </div>
              {rows.length > 0 && (
                <button
                  onClick={onClearQueue}
                  className="text-xs text-neutral-500 hover:text-rose-400"
                >
                  Clear
                </button>
              )}
            </div>

            {/* Progress bar */}
            <div className="h-1.5 rounded-full bg-neutral-800 overflow-hidden mb-3">
              <div
                className={`h-full transition-all ${
                  queuedQty > totalSlots
                    ? "bg-rose-500"
                    : queuedQty === totalSlots
                    ? "bg-emerald-500"
                    : "bg-gradient-to-r from-violet-500 to-fuchsia-500"
                }`}
                style={{
                  width: `${Math.min(100, (queuedQty / Math.max(1, totalSlots)) * 100)}%`,
                }}
              />
            </div>

            {rows.length === 0 ? (
              <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
                Empty queue. Upload artwork or choose from your catalogue below.
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={rows.map((r) => r.key)}
                  strategy={verticalListSortingStrategy}
                >
                  <ul className="space-y-2">
                    {rows.map((row, i) => (
                      <SortableQueueRow
                        key={row.key}
                        row={row}
                        index={i + 1}
                        highlighted={highlightedKey === row.key}
                        onLocate={() => toggleHighlightFromRow(row.key)}
                        onQty={(q) => updateQty(row.key, q)}
                        onRotate={() => rotateRow(row.key)}
                        onCustomize={() => setDesignerForKey(row.key)}
                        onRemove={() => removeRowAndAsset(row)}
                        onPageChange={(p) => setRowPage(row.key, p)}
                      />
                    ))}
                  </ul>
                </SortableContext>
              </DndContext>
            )}
          </section>

          {/* Upload */}
          <LockedOverlay action="artwork upload" className="rounded-2xl">
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 overflow-hidden">
            <button
              onClick={() => setUploadOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-900/60"
            >
              <span className="text-sm font-medium text-neutral-200">
                Upload artwork
              </span>
              <span className="text-neutral-500">{uploadOpen ? "−" : "+"}</span>
            </button>
            {uploadOpen && (
              <div className="px-4 pb-4">
                <label
                  onDragEnter={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragging(false);
                    if (e.dataTransfer.files.length > 0) onFiles(e.dataTransfer.files);
                  }}
                  className={`block rounded-xl border-2 border-dashed cursor-pointer text-center py-8 px-4 transition ${
                    dragging
                      ? "border-violet-400 bg-violet-500/10"
                      : "border-neutral-800 hover:border-neutral-600 bg-neutral-950/30"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    accept="application/pdf,image/svg+xml,image/png,image/jpeg,.pdf,.svg,.png,.jpg,.jpeg"
                    className="sr-only"
                    onChange={(e) => e.target.files && onFiles(e.target.files)}
                  />
                  <div className="text-3xl mb-2 text-neutral-500">⊕</div>
                  <div className="text-sm text-neutral-300 font-medium">
                    Drop files or click to upload
                  </div>
                  <div className="text-xs text-neutral-500 mt-1">
                    PDF, SVG, PNG, JPG · multiple files OK · up to 50&nbsp;MB each
                  </div>
                  {busy && (
                    <div className="text-xs text-violet-300 mt-2">Uploading…</div>
                  )}
                </label>
              </div>
            )}
          </section>
          </LockedOverlay>

          {/* Catalogue */}
          <section className="rounded-2xl border border-neutral-800 bg-neutral-900/40 overflow-hidden">
            <button
              onClick={() => setCatOpen((o) => !o)}
              className="w-full flex items-center justify-between px-4 py-3 hover:bg-neutral-900/60"
            >
              <span className="text-sm font-medium text-neutral-200">
                Choose from catalogue
              </span>
              <span className="text-neutral-500">{catOpen ? "−" : "+"}</span>
            </button>
            {catOpen && (
              <div className="px-4 pb-4 space-y-3">
                <CataloguePicker
                  activeCat={activeCat}
                  setActiveCat={setActiveCat}
                  catSearch={catSearch}
                  setCatSearch={setCatSearch}
                  assetSearch={assetSearch}
                  setAssetSearch={setAssetSearch}
                  cats={cats}
                  filteredCats={filteredCats}
                  catAssets={catAssets}
                  filteredCatAssets={filteredCatAssets}
                  expanded={false}
                  onExpand={() => setCatExpanded(true)}
                  onCollapse={() => {}}
                  addRow={addRow}
                  gridCols="grid-cols-3"
                  maxH="max-h-72"
                />
              </div>
            )}
          </section>

          {/* Full-screen catalogue overlay */}
          {catExpanded && (
            <div
              className="fixed inset-0 z-50 bg-neutral-950/95 backdrop-blur-sm overflow-y-auto"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              {/* pt-14 clears the sticky h-14 nav bar on desktop */}
              <div className="px-4 pt-16 pb-6 space-y-3">
                <CataloguePicker
                  activeCat={activeCat}
                  setActiveCat={setActiveCat}
                  catSearch={catSearch}
                  setCatSearch={setCatSearch}
                  assetSearch={assetSearch}
                  setAssetSearch={setAssetSearch}
                  cats={cats}
                  filteredCats={filteredCats}
                  catAssets={catAssets}
                  filteredCatAssets={filteredCatAssets}
                  expanded={true}
                  onExpand={() => {}}
                  onCollapse={() => setCatExpanded(false)}
                  addRow={(a, n) => { addRow(a, n); setCatExpanded(false); }}
                  gridCols="grid-cols-4 sm:grid-cols-6 lg:grid-cols-8"
                  maxH="max-h-none"
                />
              </div>
            </div>
          )}

          {/* Colour swaps - applied at Generate PDF time. Sits below the
              catalogue picker because by the time you're tweaking colours
              your assets are already chosen and queued. */}
          <JobColorsPanel
            jobId={job.id}
            filledSlotCount={Object.keys(job.assignments).length}
            assetIds={rows.map((r) => r.asset.id)}
          />

          {/* Spot colours + the per-job "include cut lines" toggle. Sits
              directly below the colour swap panel so the two PDF-output
              modifiers (RGB rewrite + add cut-path layer) live in the
              same visual region. */}
          <SpotColorsPanel
            enabled={includeCutLines}
            onEnabledChange={setIncludeCutLines}
            cutLineSpot={cutLineSpot}
            onCutLineSpotChange={setCutLineSpot}
            markSpot={markSpot}
            onMarkSpotChange={setMarkSpot}
          />

          {/* Registration mark TYPE is set on the template (so every job
              from it is produced with the marks). The colour lives in the
              Spot Colours panel above. */}
          {tpl?.registration_type ? (
            <p className="text-[11px] text-neutral-500 px-1">
              This template adds{" "}
              <span className="text-neutral-300">
                {tpl.registration_type === "velloblade"
                  ? "Velloblade"
                  : tpl.registration_type === "summa_opos"
                  ? "Summa OPOS"
                  : "Generic"}
              </span>{" "}
              registration marks to every generated PDF.
            </p>
          ) : (
            <p className="text-[11px] text-neutral-500 px-1">
              Want cutter registration marks?{" "}
              <Link
                to={`/app/templates/${job.template_id}`}
                className="text-violet-300 hover:text-violet-200"
              >
                Set them on the template →
              </Link>
            </p>
          )}
        </aside>
      </div>

      {/* Mobile-only sticky action bar so Save / Generate are always one tap
          away while scrolling the queue on a phone. Hidden on >= sm where
          the header buttons take over. Sits ABOVE iOS home indicator via
          env(safe-area-inset-bottom). Save sits above Generate, both
          full-width and the same height - Save is just as important as
          Generate, so both deserve the same physical weight. */}
      <div
        className="sm:hidden fixed bottom-0 inset-x-0 z-40 border-t border-neutral-800 bg-neutral-950/95 backdrop-blur"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex flex-col gap-2 px-3 py-2.5">
          <button
            onClick={onSaveDraft}
            disabled={busy}
            className="w-full h-12 rounded-lg border border-neutral-700 bg-neutral-900 text-sm font-semibold text-neutral-100 hover:border-neutral-500 hover:bg-neutral-800 disabled:opacity-40"
          >
            {savedHint ? "Saved ✓" : busy ? "Saving…" : "Save"}
          </button>
          {locked ? (
            <Link
              to="/pricing"
              className="w-full h-12 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-sm font-semibold text-white shadow-lg shadow-violet-500/20 flex items-center justify-center"
            >
              Subscribe to generate PDF →
            </Link>
          ) : (
            <button
              onClick={onGenerate}
              disabled={generating || queuedQty === 0}
              className="w-full h-12 rounded-lg bg-gradient-to-r from-violet-500 to-fuchsia-500 text-sm font-semibold text-white disabled:opacity-40 shadow-lg shadow-violet-500/20"
            >
              {generating
                ? "Generating…"
                : includeCutLines
                ? `Generate PDF + cut (${queuedQty}/${totalSlots})`
                : `Generate PDF (${queuedQty}/${totalSlots})`}
            </button>
          )}
        </div>
      </div>

      {designerForKey && (() => {
        const row = rows.find((r) => r.key === designerForKey);
        if (!row) return null;
        // Pick a representative slot (smallest if shapes vary, so the user
        // designs to the tightest constraint). For uniform templates this is
        // just the first shape.
        const slot = pickRepresentativeShape(tpl.shapes);
        // Resolve the artwork for the SELECTED page (artboard), not always
        // page 0. Mirrors the live-preview logic so the designer shows the
        // same artboard the user picked in the queue.
        const designerPageUrl =
          row.pageIndex > 0
            ? pagePreviewUrls[`${row.asset.id}:${row.pageIndex}`]
            : undefined;
        return (
          <SlotDesigner
            open
            onClose={() => setDesignerForKey(null)}
            onSave={(p) => applyDesignerToRow(row.key, p)}
            slotWidthPt={slot.bbox[2]}
            slotHeightPt={slot.bbox[3]}
            shapeKind={
              slot.kind === "ellipse"
                ? "ellipse"
                : slot.kind === "polygon"
                ? "polygon"
                : "rect"
            }
            shapePath={slot.kind === "polygon" ? slot.path : undefined}
            cornerRadiusMm={
              slot.kind === "ellipse" || slot.kind === "polygon"
                ? 0
                : (slot.corner_radius_pt || 0) * (25.4 / 72)
            }
            bleedMm={tpl.bleed_mm || 0}
            safeMm={tpl.safe_mm || 0}
            initial={{
              rotation_deg: row.rotationDeg,
              fit_mode: row.fitMode,
              x_mm: row.xMm,
              y_mm: row.yMm,
              w_mm: row.wMm,
              h_mm: row.hMm,
              filter_id: row.filterId,
              safe_crop: row.safeCrop,
            }}
            thumbnailUrl={designerPageUrl ?? row.asset.preview_url ?? row.asset.thumbnail_url ?? null}
            assetNaturalWmm={row.asset.width_pt ? row.asset.width_pt / PT_PER_MM : undefined}
            assetNaturalHmm={row.asset.height_pt ? row.asset.height_pt / PT_PER_MM : undefined}
            assetName={row.asset.name}
          />
        );
      })()}
    </div>
  );
}

function pickRepresentativeShape(shapes: Template["shapes"]): Template["shapes"][0] {
  // Prefer the most common slot size (handles mixed templates by giving the
  // user the size that affects the most slots in the queue order).
  if (shapes.length === 0) {
    return { page_index: 0, shape_index: 0, bbox: [0, 0, 100, 100], layer: null, is_position_slot: false };
  }
  const counts = new Map<string, number>();
  for (const s of shapes) {
    const k = `${Math.round(s.bbox[2])}x${Math.round(s.bbox[3])}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let bestKey = "";
  let best = 0;
  counts.forEach((v, k) => {
    if (v > best) {
      best = v;
      bestKey = k;
    }
  });
  return shapes.find(
    (s) => `${Math.round(s.bbox[2])}x${Math.round(s.bbox[3])}` === bestKey
  )!;
}

/** Process-wide cache for per-page thumbnail URLs.
 *
 *  Hitting the on-demand endpoint per row + per page would be wasteful
 *  when the same multi-page asset appears in dozens of rows. We dedupe
 *  by (assetId, pageIndex) so each unique page is fetched at most once
 *  per session. Presigned URLs live for an hour which comfortably
 *  outlives a JobFiller session.
 */
const pageThumbCache = new Map<string, Promise<string>>();

function fetchPageThumb(assetId: string, pageIndex: number): Promise<string> {
  const key = `${assetId}:${pageIndex}`;
  let p = pageThumbCache.get(key);
  if (!p) {
    p = getAssetPageThumbnail(assetId, pageIndex).then((r) => r.url);
    pageThumbCache.set(key, p);
    // Drop the cache entry if the fetch failed so the next render retries.
    p.catch(() => pageThumbCache.delete(key));
  }
  return p;
}

/** Resolves the thumbnail URL for `pageIndex` of `assetId`, falling back
 *  to `defaultUrl` (the asset's primary thumbnail) while loading or on
 *  error. Page 0 always returns the default immediately. */
function usePageThumbnail(
  assetId: string,
  pageIndex: number,
  defaultUrl: string | null
): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ url: string | null; loading: boolean }>(
    pageIndex === 0
      ? { url: defaultUrl, loading: false }
      : { url: null, loading: true }
  );
  useEffect(() => {
    if (pageIndex === 0) {
      setState({ url: defaultUrl, loading: false });
      return;
    }
    let cancelled = false;
    setState({ url: null, loading: true });
    fetchPageThumb(assetId, pageIndex)
      .then((u) => {
        if (!cancelled) setState({ url: u, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ url: defaultUrl, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [assetId, pageIndex, defaultUrl]);
  return state;
}

/** Inline page picker for multi-page PDF assets. Renders a compact pill
 *  showing "Pg X/N"; clicking it opens a popover with lazy-loaded
 *  thumbnails of every page so the user can pick the side/artboard for
 *  this slot. No-op when the asset is single-page. */
function PagePicker({
  asset,
  pageIndex,
  onChange,
}: {
  asset: Asset;
  pageIndex: number;
  onChange: (pageIndex: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const pageCount = asset.page_count ?? 1;

  // Click-outside to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (pageCount <= 1) return null;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-11 px-2.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:border-amber-400 hover:bg-amber-500/15 flex items-center gap-1.5 text-xs font-medium whitespace-nowrap"
        title={`Pick which page to use (this asset has ${pageCount} pages)`}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className="font-mono tabular-nums">
          Pg {pageIndex + 1}/{pageCount}
        </span>
        <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
          <path
            d={open ? "M2 6.5L5 3.5L8 6.5" : "M2 4l3 3 3-3"}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Choose page"
          className="absolute right-0 top-full mt-1.5 z-30 w-[260px] rounded-lg border border-neutral-700 bg-neutral-950 shadow-2xl shadow-black/40 p-3"
        >
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-2">
            Choose page · {pageCount} available
          </div>
          <div className="grid grid-cols-3 gap-2 max-h-[260px] overflow-y-auto">
            {Array.from({ length: pageCount }).map((_, n) => (
              <PageThumb
                key={n}
                asset={asset}
                pageIndex={n}
                selected={n === pageIndex}
                onPick={() => {
                  onChange(n);
                  setOpen(false);
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PageThumb({
  asset,
  pageIndex,
  selected,
  onPick,
}: {
  asset: Asset;
  pageIndex: number;
  selected: boolean;
  onPick: () => void;
}) {
  const { url, loading } = usePageThumbnail(
    asset.id,
    pageIndex,
    asset.preview_url ?? asset.thumbnail_url ?? null
  );
  return (
    <button
      type="button"
      onClick={onPick}
      className={`relative aspect-square rounded-md overflow-hidden border bg-neutral-900 flex items-center justify-center group transition ${
        selected
          ? "border-violet-400 ring-2 ring-violet-400/40"
          : "border-neutral-800 hover:border-violet-500/60"
      }`}
      aria-pressed={selected}
      aria-label={`Use page ${pageIndex + 1}`}
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="w-full h-full object-contain p-1"
          loading="lazy"
        />
      ) : loading ? (
        <span
          className="h-4 w-4 rounded-full border-2 border-neutral-700 border-t-violet-400 animate-spin"
          aria-label="Loading preview"
        />
      ) : (
        <span className="text-[10px] text-neutral-500">no preview</span>
      )}
      <span className="absolute bottom-0.5 right-0.5 text-[9px] font-mono tabular-nums bg-black/70 text-neutral-200 px-1 rounded">
        {pageIndex + 1}
      </span>
    </button>
  );
}

/** Thumbnail button that opens the placement designer.
 *
 *  Pulled out of `SortableQueueRow` so it can use a hook to load a
 *  page-specific preview for multi-page PDFs (page 0 falls through to
 *  the asset's primary thumbnail; pages 1+ fetch on demand and cache
 *  in `pageThumbCache`). */
function RowThumbnailButton({
  asset,
  pageIndex,
  rotationDeg,
  onCustomize,
}: {
  asset: Asset;
  pageIndex: number;
  rotationDeg: number;
  onCustomize: () => void;
}) {
  const { url, loading } = usePageThumbnail(
    asset.id,
    pageIndex,
    asset.preview_url ?? asset.thumbnail_url ?? null
  );
  return (
    <button
      onClick={onCustomize}
      className="h-11 w-11 shrink-0 rounded-md border border-neutral-800 overflow-hidden bg-neutral-900 flex items-center justify-center hover:border-violet-500 transition relative group"
      title="Open designer to customise placement"
      aria-label="Open designer"
    >
      {url ? (
        <img
          src={url}
          alt=""
          className="w-full h-full object-contain p-1.5 transition-transform"
          style={{ transform: `rotate(${rotationDeg}deg)` }}
        />
      ) : loading ? (
        <span
          className="h-3.5 w-3.5 rounded-full border-2 border-neutral-700 border-t-violet-400 animate-spin"
          aria-label="Loading preview"
        />
      ) : (
        <span className="text-[10px] text-neutral-500 uppercase">
          {asset.kind}
        </span>
      )}
      <div className="absolute inset-0 flex items-center justify-center bg-violet-500/0 group-hover:bg-violet-500/30 transition">
        <svg
          className="opacity-0 group-hover:opacity-100 transition text-white"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M11.5 2.5l2 2L6 12l-3 1 1-3 7.5-7.5z" />
        </svg>
      </div>
    </button>
  );
}

function SortableQueueRow({
  row,
  index,
  highlighted,
  onLocate,
  onQty,
  onRotate,
  onCustomize,
  onRemove,
  onPageChange,
}: {
  row: QueueRow;
  index: number;
  /** Drives the violet "you are here" ring when the user has either
   *  clicked this row or clicked one of its slots in the layout preview. */
  highlighted: boolean;
  /** Called when the user clicks the row's info area to ask "where is
   *  this in the layout?". The parent toggles the bidirectional
   *  highlight + scrolls the preview into view. */
  onLocate: () => void;
  onQty: (qty: number) => void;
  onRotate: () => void;
  onCustomize: () => void;
  onRemove: () => void;
  /** Called with a new 0-based page index when the user picks a
   *  different page from a multi-page PDF asset. Only meaningful when
   *  `row.asset.page_count > 1`. */
  onPageChange: (pageIndex: number) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: row.key });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
    // NOTE: deliberately NOT setting `touch-action: none` on the row.
    // The TouchSensor uses delay-based activation (see `sensors` in the
    // parent), which is designed to coexist with native scrolling -
    // moving the finger before the delay lets the browser scroll, holding
    // still claims the touch for dnd. Setting `touch-action: none` here
    // would disable mobile scroll over the queue (every touch would be
    // captured by the row), which made tall queues unscrollable on phones.
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      data-queue-row-key={row.key}
      className={`flex items-center gap-2 rounded-xl border bg-neutral-950/50 px-2 py-2 transition ${
        isDragging
          ? "border-violet-500 shadow-lg shadow-violet-500/30"
          : highlighted
          ? "border-violet-500 ring-2 ring-violet-500/40 shadow-lg shadow-violet-500/20"
          : "border-neutral-800"
      }`}
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-neutral-600 hover:text-neutral-300 h-11 w-8 flex items-center justify-center -ml-1"
        aria-label="Drag to reorder (long-press on touch)"
        title="Drag to reorder"
        // Only the grip handle disables native touch scroll, so once the
        // user lands on it the long-press drag is unambiguous. Everywhere
        // else on the row, the page can still scroll normally.
        style={{ touchAction: "none" }}
      >
        <svg width="14" height="20" viewBox="0 0 14 20" fill="currentColor">
          <circle cx="3" cy="4" r="1.6" />
          <circle cx="3" cy="10" r="1.6" />
          <circle cx="3" cy="16" r="1.6" />
          <circle cx="11" cy="4" r="1.6" />
          <circle cx="11" cy="10" r="1.6" />
          <circle cx="11" cy="16" r="1.6" />
        </svg>
      </button>
      <RowThumbnailButton
        asset={row.asset}
        pageIndex={row.pageIndex}
        rotationDeg={row.rotationDeg}
        onCustomize={onCustomize}
      />
      <button
        type="button"
        onClick={onLocate}
        className={`flex-1 min-w-0 text-left rounded-md -mx-1 px-1.5 py-1 transition group/locate ${
          highlighted
            ? "bg-violet-500/10"
            : "hover:bg-violet-500/5"
        }`}
        title="Find this artwork in the layout"
        aria-label={`Find ${row.asset.name} in layout`}
        aria-pressed={highlighted}
      >
        <div
          className="text-sm text-neutral-200 flex items-start gap-1 leading-tight"
          title={row.asset.name}
        >
          <span className="text-neutral-500 font-mono shrink-0">{index}.</span>
          <span className="line-clamp-2 break-words">{row.asset.name}</span>
        </div>
        <div className="text-[11px] text-neutral-500 mt-0.5 flex items-center gap-1.5 flex-wrap">
          <span>{row.asset.job_id ? "Uploaded" : "Catalogue"}</span>
          {row.rotationDeg !== 0 && (
            <span className="text-violet-300 font-mono">
              · {row.rotationDeg}°
            </span>
          )}
          {row.fitMode === "manual" && (
            <span className="text-fuchsia-300 font-mono">· custom</span>
          )}
          <span
            className={`ml-auto inline-flex items-center gap-0.5 transition ${
              highlighted
                ? "text-violet-300"
                : "text-neutral-700 group-hover/locate:text-violet-400"
            }`}
            aria-hidden
          >
            {/* Map-pin glyph - communicates "find this on the layout" without
                stealing horizontal space when the row is at rest. Goes solid
                violet while the row is the active highlight target. */}
            <svg
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M8 14s5-4.5 5-8.5a5 5 0 0 0-10 0c0 4 5 8.5 5 8.5z" />
              <circle cx="8" cy="5.5" r="1.6" />
            </svg>
            <span className="text-[10px]">
              {highlighted ? "Showing" : "Find"}
            </span>
          </span>
        </div>
      </button>
      <PagePicker
        asset={row.asset}
        pageIndex={row.pageIndex}
        onChange={onPageChange}
      />
      <button
        onClick={onRotate}
        className="h-11 w-9 rounded-md border border-neutral-800 text-neutral-400 hover:border-violet-500 hover:text-violet-300 flex items-center justify-center"
        aria-label="Rotate 90°"
        title={`Rotate 90° (currently ${row.rotationDeg}°)`}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 7a5 5 0 0 1 8.5-3.5L13 5" />
          <path d="M13 2v3h-3" />
        </svg>
      </button>
      <div className="flex items-center">
        <button
          onClick={() => onQty(row.qty - 1)}
          disabled={row.qty <= 1}
          className="h-11 w-8 rounded-l-md border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white disabled:opacity-30 text-lg leading-none"
          aria-label="Decrease"
        >
          −
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={row.qty}
          onChange={(e) => onQty(Math.max(1, parseInt(e.target.value) || 1))}
          className="w-12 h-11 border-y border-neutral-800 bg-neutral-950 text-center font-mono text-sm outline-none focus:border-violet-500 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        />
        <button
          onClick={() => onQty(row.qty + 1)}
          className="h-11 w-8 rounded-r-md border border-neutral-800 text-neutral-400 hover:border-neutral-600 hover:text-white text-lg leading-none"
          aria-label="Increase"
        >
          +
        </button>
      </div>
      <button
        onClick={onRemove}
        className="h-11 w-8 text-neutral-600 hover:text-rose-400 flex items-center justify-center"
        aria-label="Remove from queue"
        title="Remove"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M3 5h10M6 5V3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1V5M5 5l.5 8a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 5" />
        </svg>
      </button>
    </li>
  );
}
