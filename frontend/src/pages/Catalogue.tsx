import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import {
  Asset,
  Category,
  createCategory,
  deleteAsset,
  deleteCategory,
  exportCategory,
  importCategory,
  listAssets,
  listCategories,
  uploadAsset,
} from "../api/catalogue";

export default function Catalogue() {
  const [cats, setCats] = useState<Category[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [newCatName, setNewCatName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function loadCats() {
    const c = await listCategories();
    setCats(c);
    if (!active && c.length > 0) setActive(c[0].id);
  }

  useEffect(() => {
    loadCats().catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    if (!active) return;
    listAssets(active).then(setAssets).catch((e) => setErr(String(e)));
  }, [active]);

  async function onCreateCat(e: FormEvent) {
    e.preventDefault();
    if (!newCatName.trim()) return;
    const c = await createCategory(newCatName.trim());
    setNewCatName("");
    setActive(c.id);
    loadCats();
  }

  async function onDeleteCat(id: string) {
    if (!confirm("Delete this category and ALL its assets?")) return;
    await deleteCategory(id);
    if (active === id) setActive(null);
    setAssets(null);
    loadCats();
  }

  async function onUpload(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0 || !active) return;
    e.target.value = "";
    setBusy(true);
    setErr(null);
    try {
      for (const f of files) {
        await uploadAsset(active, f, f.name);
      }
      const refreshed = await listAssets(active);
      setAssets(refreshed);
    } catch (e2) {
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteAsset(id: string) {
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
      setErr(String(e2));
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
      setErr(String(e2));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-6xl mx-auto px-6 py-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">Catalogue</h1>
        <p className="text-neutral-400 mt-1">
          Upload PDFs, SVGs, PNGs, or JPGs. Group them into categories. Pull them
          into jobs by name.
        </p>
      </div>

      {err && <div className="text-rose-400 text-sm mb-4">{err}</div>}

      <div className="grid lg:grid-cols-[260px_1fr] gap-6">
        <div className="space-y-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500 mb-2">
            Categories
          </div>
          <div className="space-y-1">
            {cats?.map((c) => (
              <div
                key={c.id}
                className={`flex items-center justify-between rounded-md px-3 py-2 cursor-pointer ${
                  active === c.id
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
                onClick={() => setActive(c.id)}
              >
                <span>{c.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeleteCat(c.id);
                  }}
                  className="text-xs text-neutral-500 hover:text-rose-400"
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
              <div className="flex items-center justify-between mb-4 gap-3">
                <div className="text-sm text-neutral-400">
                  {assets?.length ?? 0} assets
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onExport(active)}
                    disabled={busy || (assets?.length ?? 0) === 0}
                    className="rounded-lg border border-neutral-700 px-3 py-2 text-sm text-neutral-200 hover:border-neutral-500 disabled:opacity-40"
                    title="Download a .printlay.zip bundle of this category"
                  >
                    ↧ Export
                  </button>
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
                </div>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
                {assets?.map((a) => (
                  <div
                    key={a.id}
                    className="group relative aspect-square rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden"
                  >
                    {a.thumbnail_url ? (
                      <img
                        src={a.thumbnail_url}
                        alt={a.name}
                        className="w-full h-full object-contain p-1"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-neutral-500 uppercase">
                        {a.kind}
                      </div>
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-2 text-xs text-neutral-200 opacity-0 group-hover:opacity-100 transition">
                      <div className="truncate">{a.name}</div>
                    </div>
                    <button
                      onClick={() => onDeleteAsset(a.id)}
                      className="absolute top-1 right-1 rounded-md bg-black/70 px-1.5 py-0.5 text-xs text-white opacity-0 group-hover:opacity-100 hover:bg-rose-600"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              {assets?.length === 0 && (
                <div className="rounded-2xl border border-dashed border-neutral-800 p-12 text-center text-neutral-500">
                  Empty category. Drop in some PDFs, SVGs, PNGs, or JPGs.
                </div>
              )}
            </>
          ) : (
            <div className="text-neutral-500">
              Create a category to start uploading.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
