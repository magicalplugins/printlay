import { ChangeEvent, DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  adminSetOfficial,
  Asset,
  Category,
  createCategory,
  deleteAsset,
  deleteCategory,
  exportCategory,
  importCategory,
  listAssets,
  listCategories,
  listOfficialCatalogues,
  subscribeToCatalogue,
  unsubscribeFromCatalogue,
  uploadAsset,
} from "../api/catalogue";
import { useMe } from "../auth/MeProvider";
import QuotaErrorBanner from "../components/app/QuotaErrorBanner";
import UsageHint from "../components/app/UsageHint";
import { formatApiError, FormattedApiError } from "../utils/apiError";

function OfficialBadge() {
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-fuchsia-500/15 text-fuchsia-300 text-[9px] uppercase tracking-widest border border-fuchsia-500/30">
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
        <path
          d="M4 0l1.2 2.5L8 3l-2 2 .5 3L4 6.5 1.5 8 2 5 0 3l2.8-.5z"
          fill="currentColor"
        />
      </svg>
      Official
    </span>
  );
}

export default function Catalogue() {
  const { me } = useMe();
  const isAdmin = !!me?.is_admin;

  const [cats, setCats] = useState<Category[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<FormattedApiError | null>(null);
  const reportErr = (e: unknown) => setErr(formatApiError(e));

  // Browse-officials drawer
  const [browseOpen, setBrowseOpen] = useState(false);
  const [officials, setOfficials] = useState<Category[] | null>(null);
  const [officialsBusy, setOfficialsBusy] = useState(false);

  // Drag-and-drop state
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);

  // Without a global preventDefault, dropping a file *outside* the dropzone
  // makes the browser navigate to it (image opens in a new tab). Capture
  // every dragover/drop on window so the only thing that ever fires the
  // file is our intentional handler below.
  useEffect(() => {
    const preventNav = (e: globalThis.DragEvent) => {
      e.preventDefault();
    };
    window.addEventListener("dragover", preventNav);
    window.addEventListener("drop", preventNav);
    return () => {
      window.removeEventListener("dragover", preventNav);
      window.removeEventListener("drop", preventNav);
    };
  }, []);

  const activeCat = useMemo(
    () => cats?.find((c) => c.id === active) ?? null,
    [cats, active]
  );
  const isReadOnly = !!activeCat?.is_official && !isAdmin;

  async function loadCats() {
    const c = await listCategories();
    setCats(c);
    if (!active && c.length > 0) setActive(c[0].id);
  }

  useEffect(() => {
    loadCats().catch(reportErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!active) return;
    listAssets(active).then(setAssets).catch(reportErr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  async function openBrowse() {
    setBrowseOpen(true);
    if (officials !== null) return;
    setOfficialsBusy(true);
    try {
      setOfficials(await listOfficialCatalogues());
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function refreshOfficials() {
    try {
      setOfficials(await listOfficialCatalogues());
    } catch (e) {
      reportErr(e);
    }
  }

  async function onSubscribe(catId: string) {
    setOfficialsBusy(true);
    try {
      await subscribeToCatalogue(catId);
      await Promise.all([refreshOfficials(), loadCats()]);
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function onUnsubscribe(catId: string) {
    if (!confirm("Remove this catalogue from your library?")) return;
    setOfficialsBusy(true);
    try {
      await unsubscribeFromCatalogue(catId);
      if (active === catId) {
        setActive(null);
        setAssets(null);
      }
      await Promise.all([refreshOfficials(), loadCats()]);
    } catch (e) {
      reportErr(e);
    } finally {
      setOfficialsBusy(false);
    }
  }

  async function onCreateCat(e: FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const c = await createCategory(newCatName.trim());
    setNewCatName("");
    setActive(c.id);
    loadCats();
  }

  async function onDeleteCat(id: string) {
    const c = cats?.find((x) => x.id === id);
    if (c?.is_official && !isAdmin) {
      // Subscriber clicking "remove" - actually unsubscribe.
      await onUnsubscribe(id);
      return;
    }
    if (!confirm("Delete this category and ALL its assets?")) return;
    await deleteCategory(id);
    if (active === id) setActive(null);
    setAssets(null);
    loadCats();
  }

  const ACCEPTED = /\.(pdf|svg|png|jpe?g)$/i;

  async function uploadFiles(files: File[]) {
    if (files.length === 0 || !active || isReadOnly) return;
    const valid = files.filter(
      (f) =>
        ACCEPTED.test(f.name) ||
        /^(application\/pdf|image\/(svg\+xml|png|jpeg))$/.test(f.type)
    );
    const skipped = files.length - valid.length;
    if (valid.length === 0) {
      setErr({
        message: `Only PDF, SVG, PNG, or JPG files are accepted (${skipped} ignored).`,
        suggestsUpgrade: false,
      });
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      for (const f of valid) {
        await uploadAsset(active, f, f.name);
      }
      const refreshed = await listAssets(active);
      setAssets(refreshed);
      if (skipped > 0) {
        setErr({
          message: `Uploaded ${valid.length} file${valid.length === 1 ? "" : "s"}; skipped ${skipped} unsupported file${skipped === 1 ? "" : "s"}.`,
          suggestsUpgrade: false,
        });
      }
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    await uploadFiles(files);
  }

  function onDropFiles(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragOver(false);
    if (!active || isReadOnly) return;
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    void uploadFiles(files);
  }

  function onDragEnter(e: DragEvent<HTMLDivElement>) {
    if (!active || isReadOnly) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current += 1;
    setDragOver(true);
  }

  function onDragOver(e: DragEvent<HTMLDivElement>) {
    if (!active || isReadOnly) return;
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }

  function onDragLeave(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragOver(false);
  }

  async function onDeleteAsset(id: string) {
    if (isReadOnly) return;
    if (!confirm("Delete this asset?")) return;
    await deleteAsset(id);
    if (active) setAssets(await listAssets(active));
  }

  async function onExport(id: string) {
    setBusy(true);
    setErr(null);
    try {
      const blob = await exportCategory(id);
      const url = URL.createObjectURL(blob);
      const cat = cats?.find((c) => c.id === id);
      const safe = (cat?.name || "category").replace(/[^a-z0-9_-]+/gi, "_");
      const a = document.createElement("a");
      a.href = url;
      a.download = `printlay-${safe}.printlay.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onImport(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setBusy(true);
    setErr(null);
    try {
      const cat = await importCategory(file);
      await loadCats();
      setActive(cat.id);
    } catch (e2) {
      reportErr(e2);
    } finally {
      setBusy(false);
    }
  }

  async function onToggleOfficial() {
    if (!isAdmin || !activeCat || activeCat.is_official === undefined) return;
    setBusy(true);
    try {
      await adminSetOfficial(activeCat.id, !activeCat.is_official);
      await loadCats();
      setOfficials(null); // force re-fetch on next browse open
    } catch (e) {
      reportErr(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="mb-8 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-3xl font-bold tracking-tight">Catalogue</h1>
            <UsageHint metric="storage" />
            <UsageHint metric="categories" />
          </div>
          <p className="text-neutral-400 mt-1">
            Upload PDFs, SVGs, PNGs, or JPGs. Group them into categories.
            Pull them into jobs by name.
          </p>
        </div>
        <button
          onClick={openBrowse}
          className="inline-flex items-center gap-2 rounded-lg border border-fuchsia-500/40 bg-fuchsia-500/10 px-4 py-2 text-sm text-fuchsia-200 hover:bg-fuchsia-500/15"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <path
              d="M7 0l1.7 4.3 4.6.4-3.5 3 1 4.5L7 9.9 3.2 12.2l1-4.5L.7 4.7l4.6-.4z"
              fill="currentColor"
            />
          </svg>
          Browse official catalogues
        </button>
      </div>

      {err && (
        <div className="mb-4">
          <QuotaErrorBanner error={err} />
        </div>
      )}

      <div className="grid lg:grid-cols-[260px_1fr] gap-6">
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
            Categories
          </div>
          <div className="space-y-1">
            {cats?.map((c) => (
              <div
                key={c.id}
                className={`flex items-center justify-between gap-2 rounded-md px-3 py-2 cursor-pointer ${
                  active === c.id
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
                onClick={() => setActive(c.id)}
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span className="truncate">{c.name}</span>
                  {c.is_official && <OfficialBadge />}
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCat(c.id);
                  }}
                  className="text-xs text-neutral-500 hover:text-rose-400"
                  title={
                    c.is_official && !isAdmin
                      ? "Unsubscribe from this catalogue"
                      : "Delete category"
                  }
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <form onSubmit={onCreateCat} className="flex gap-2 pt-3">
            <input
              type="text"
              value={newCatName}
              onChange={(e) => setNewCatName(e.target.value)}
              placeholder="New category"
              className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
            />
            <button
              type="submit"
              className="rounded-md bg-white px-3 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
            >
              +
            </button>
          </form>

          <label className="block w-full rounded-md border border-dashed border-neutral-800 px-3 py-2 text-center text-xs text-neutral-400 hover:border-neutral-600 hover:text-neutral-200 cursor-pointer">
            {busy ? "Importing…" : "↥ Import .printlay.zip"}
            <input
              type="file"
              accept=".zip,application/zip"
              onChange={onImport}
              className="hidden"
            />
          </label>
        </div>

        <div>
          {active ? (
            <>
              <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
                <div className="text-sm text-neutral-400 flex items-center gap-2">
                  {activeCat?.is_official && <OfficialBadge />}
                  {assets?.length ?? 0} assets
                  {isReadOnly && (
                    <span className="text-xs text-neutral-500">
                      · read-only (subscribed catalogue)
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {isAdmin && activeCat && (
                    <button
                      onClick={onToggleOfficial}
                      disabled={busy}
                      className={`rounded-lg border px-3 py-2 text-sm transition ${
                        activeCat.is_official
                          ? "border-fuchsia-500/50 bg-fuchsia-500/10 text-fuchsia-200 hover:bg-fuchsia-500/15"
                          : "border-neutral-700 text-neutral-200 hover:border-fuchsia-400 hover:text-fuchsia-200"
                      }`}
                      title={
                        activeCat.is_official
                          ? "Unmark - hide from Browse drawer for everyone"
                          : "Mark as Official - users can subscribe to it"
                      }
                    >
                      {activeCat.is_official
                        ? "★ Marked Official"
                        : "☆ Mark as Official"}
                    </button>
                  )}
                  <button
                    onClick={() => onExport(active)}
                    disabled={busy || (assets?.length ?? 0) === 0}
                    className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
                    title="Download a .printlay.zip bundle of this category"
                  >
                    ↧ Export
                  </button>
                  {!isReadOnly && (
                    <label className="rounded-lg bg-white px-4 py-2 text-sm font-semibold text-neutral-950 hover:bg-neutral-200 cursor-pointer">
                      {busy ? "Uploading…" : "+ Add files"}
                      <input
                        type="file"
                        accept=".pdf,.svg,.png,.jpg,.jpeg,application/pdf,image/svg+xml,image/png,image/jpeg"
                        multiple
                        onChange={onUpload}
                        className="hidden"
                      />
                    </label>
                  )}
                </div>
              </div>

              <div
                onDragEnter={onDragEnter}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                onDrop={onDropFiles}
                className={`relative rounded-2xl transition ${
                  dragOver && !isReadOnly
                    ? "ring-2 ring-fuchsia-400/70 bg-fuchsia-500/5"
                    : ""
                }`}
              >
                {assets && assets.length > 0 ? (
                  <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                    {assets.map((a) => (
                      <div
                        key={a.id}
                        className="group relative aspect-square rounded-lg border border-neutral-800 bg-white overflow-hidden ring-1 ring-black/5 shadow-sm"
                      >
                        {a.preview_url || a.thumbnail_url ? (
                          <img
                            src={a.preview_url ?? a.thumbnail_url ?? ""}
                            alt={a.name}
                            className="w-full h-full object-contain p-1 pointer-events-none"
                            draggable={false}
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-xs text-neutral-400 uppercase">
                            {a.kind}
                          </div>
                        )}
                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-xs text-neutral-200 opacity-0 group-hover:opacity-100 transition pointer-events-none">
                          <div className="truncate">{a.name}</div>
                        </div>
                        {!isReadOnly && (
                          <button
                            onClick={() => onDeleteAsset(a.id)}
                            className="absolute top-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 hover:bg-rose-600"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    className={`rounded-2xl border border-dashed p-12 text-center transition ${
                      dragOver && !isReadOnly
                        ? "border-fuchsia-400 text-fuchsia-200"
                        : "border-neutral-800 text-neutral-500"
                    }`}
                  >
                    {isReadOnly
                      ? "This official catalogue is empty."
                      : "Drag files here, or click + Add files. PDFs, SVGs, PNGs, JPGs."}
                  </div>
                )}

                {dragOver && !isReadOnly && (
                  <div className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-dashed border-fuchsia-400 bg-neutral-950/70 backdrop-blur-sm">
                    <div className="text-fuchsia-200 font-medium text-sm">
                      Drop to upload to <span className="font-semibold">{activeCat?.name}</span>
                    </div>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="text-neutral-500">
              Create a category, or browse official catalogues to subscribe to one.
            </div>
          )}
        </div>
      </div>

      {/* Browse drawer */}
      {browseOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-6"
          onClick={() => setBrowseOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-2xl bg-neutral-950 border border-neutral-800 rounded-t-2xl sm:rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
          >
            <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-900">
              <div>
                <div className="font-semibold">Official catalogues</div>
                <div className="text-xs text-neutral-500">
                  Curated by the Printlay team. Subscribe to add one to
                  your library; unsubscribe any time.
                </div>
              </div>
              <button
                onClick={() => setBrowseOpen(false)}
                className="rounded-lg border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-600"
              >
                Close
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-2">
              {officialsBusy && (
                <div className="text-sm text-neutral-500">Loading…</div>
              )}
              {!officialsBusy && (officials?.length ?? 0) === 0 && (
                <div className="text-sm text-neutral-500 py-8 text-center">
                  No official catalogues available yet.
                  {isAdmin && (
                    <div className="mt-2 text-xs text-neutral-400">
                      Tip: create a category, upload assets, then click
                      "Mark as Official" to publish it here.
                    </div>
                  )}
                </div>
              )}
              {(officials ?? []).map((c) => (
                <div
                  key={c.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-neutral-900 bg-neutral-950 px-4 py-3 hover:border-neutral-700"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-sm flex items-center gap-2">
                      <OfficialBadge />
                      {c.name}
                    </div>
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {c.asset_count ?? 0} asset
                      {c.asset_count === 1 ? "" : "s"}
                    </div>
                  </div>
                  {c.subscribed ? (
                    <button
                      onClick={() => onUnsubscribe(c.id)}
                      disabled={officialsBusy}
                      className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/15"
                    >
                      ✓ Subscribed
                    </button>
                  ) : (
                    <button
                      onClick={() => onSubscribe(c.id)}
                      disabled={officialsBusy}
                      className="rounded-md bg-fuchsia-500 hover:bg-fuchsia-400 px-3 py-1.5 text-xs font-semibold text-white"
                    >
                      Subscribe
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
