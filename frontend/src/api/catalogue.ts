import { api } from "./client";

export type Category = {
  id: string;
  name: string;
  created_at: string;
  is_official?: boolean;
  is_private_share?: boolean;
  subscribed?: boolean;
  asset_count?: number | null;
};

export type Asset = {
  id: string;
  category_id: string | null;
  job_id: string | null;
  name: string;
  kind: "pdf" | "svg" | "png" | "jpg";
  width_pt: number;
  height_pt: number;
  file_size: number;
  page_count?: number;
  thumbnail_url: string | null;
  preview_url: string | null;
  created_at: string;
  is_official?: boolean;
  /** For stickers: custom cut line as normalised [x, y] points (0..1,
   *  top-left origin) in the asset's own space. Null = use bounding box. */
  cut_contour?: number[][] | null;
  /** Present = this asset was created with the sticker editor and can be
   *  re-opened for further editing. */
  is_sticker_editable?: boolean;
};

export type AssetPageThumbnail = {
  url: string;
  page_index: number;
  page_count: number;
};

export const getAssetPageThumbnail = (assetId: string, pageIndex: number) =>
  api<AssetPageThumbnail>(
    `/api/assets/${assetId}/pages/${pageIndex}/thumbnail`
  );

export const listCategories = () => api<Category[]>("/api/categories");

export const createCategory = (name: string) =>
  api<Category>("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const deleteCategory = (id: string) =>
  api<void>(`/api/categories/${id}`, { method: "DELETE" });

export const renameCategory = (id: string, name: string) =>
  api<Category>(`/api/categories/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });

export const listAssets = (categoryId: string) =>
  api<Asset[]>(`/api/categories/${categoryId}/assets`);

export async function uploadAsset(
  categoryId: string,
  file: File,
  name?: string
) {
  const fd = new FormData();
  fd.append("category_id", categoryId);
  fd.append("file", file);
  if (name) fd.append("name", name);
  return api<Asset>("/api/assets", { method: "POST", body: fd });
}

export const deleteAsset = (id: string) =>
  api<void>(`/api/assets/${id}`, { method: "DELETE" });

/** Download a single asset's file. For stickers with a cut line, pass a
 *  `spotName` to re-tag the embedded cut separation to that spot colour
 *  (e.g. Mimaki "Through-cut"). Triggers a browser download. */
export async function downloadAsset(
  asset: Pick<Asset, "id" | "name" | "kind">,
  spotName?: string
): Promise<void> {
  const { getSupabase } = await import("../auth/supabase");
  const supabase = await getSupabase().catch(() => null);
  const headers: Record<string, string> = {};
  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token)
      headers.Authorization = `Bearer ${session.access_token}`;
  }
  const sp = new URLSearchParams();
  if (spotName) sp.set("spot_name", spotName);
  const qs = sp.toString();
  const res = await fetch(
    `/api/assets/${asset.id}/download${qs ? `?${qs}` : ""}`,
    { headers }
  );
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const ext = asset.kind === "pdf" ? "pdf" : asset.kind;
  const safe = asset.name.replace(/[^a-z0-9\-_ ]/gi, "_").trim() || "asset";
  a.download = `${safe}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}

export type BulkDeleteResult = { deleted: number; skipped: number };

/** Delete many assets in one round-trip. Capped at 500 ids server-side.
 *  Skipped count covers ids the caller doesn't own (e.g. stale cache);
 *  those are silently ignored. */
export const bulkDeleteAssets = (assetIds: string[]) =>
  api<BulkDeleteResult>("/api/assets/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ asset_ids: assetIds }),
  });

/** Get thumbnail URLs for a batch of asset IDs in one round-trip. */
export const bulkThumbnails = (assetIds: string[]) =>
  api<Record<string, string | null>>("/api/assets/bulk-thumbnails", {
    method: "POST",
    body: JSON.stringify({ asset_ids: assetIds }),
  });

export function exportCategoryUrl(categoryId: string): string {
  // Browser-direct download: streams the bundle without buffering through JS.
  return `/api/categories/${categoryId}/export`;
}

export async function exportCategory(categoryId: string): Promise<Blob> {
  const { getSupabase } = await import("../auth/supabase");
  const supabase = await getSupabase().catch(() => null);
  const headers: Record<string, string> = {};
  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) headers.Authorization = `Bearer ${session.access_token}`;
  }
  const res = await fetch(`/api/categories/${categoryId}/export`, { headers });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return await res.blob();
}

export async function importCategory(
  file: File,
  targetCategoryId?: string
): Promise<Category> {
  const fd = new FormData();
  fd.append("file", file);
  if (targetCategoryId) fd.append("target_category_id", targetCategoryId);
  return api<Category>("/api/categories/import", { method: "POST", body: fd });
}

// ---- Official catalogues (opt-in subscriptions) ----

export const listOfficialCatalogues = () =>
  api<Category[]>("/api/catalogues/official");

export const subscribeToCatalogue = (categoryId: string) =>
  api<Category>(`/api/catalogues/${categoryId}/subscribe`, { method: "POST" });

export const unsubscribeFromCatalogue = (categoryId: string) =>
  api<void>(`/api/catalogues/${categoryId}/subscribe`, { method: "DELETE" });

// ---- Admin: mark a catalogue as official + push subscriptions ----

export const adminSetOfficial = (categoryId: string, isOfficial: boolean) =>
  api<Category>(
    `/api/admin/catalogues/${categoryId}?is_official=${isOfficial}`,
    { method: "PATCH" }
  );

export const adminSetPrivateShare = (categoryId: string, isPrivateShare: boolean) =>
  api<Category>(
    `/api/admin/catalogues/${categoryId}/private-share?is_private_share=${isPrivateShare}`,
    { method: "PATCH" }
  );

export const adminAssignSubscriber = (categoryId: string, userId: string) =>
  api<void>(
    `/api/admin/catalogues/${categoryId}/assign?user_id=${userId}`,
    { method: "POST" }
  );

export const adminUnassignSubscriber = (categoryId: string, userId: string) =>
  api<void>(
    `/api/admin/catalogues/${categoryId}/assign?user_id=${userId}`,
    { method: "DELETE" }
  );

export type CatalogueSubscriber = {
  id: string;
  email: string;
  display_name: string | null;
};

export const adminListSubscribers = (categoryId: string) =>
  api<CatalogueSubscriber[]>(`/api/admin/catalogues/${categoryId}/subscribers`);

export type AdminCatalogueItem = {
  id: string;
  name: string;
  owner_email: string;
  asset_count: number;
  is_official: boolean;
  is_private_share: boolean;
  created_at: string | null;
  thumbnails: string[];
};

export type AdminCataloguesPage = {
  total: number;
  items: AdminCatalogueItem[];
};

export const getAdminCatalogues = (params: {
  q?: string;
  filter?: string;
  sort?: string;
  limit?: number;
  offset?: number;
}) => {
  const sp = new URLSearchParams();
  if (params.q) sp.set("q", params.q);
  if (params.filter) sp.set("filter", params.filter);
  if (params.sort) sp.set("sort", params.sort);
  if (params.limit) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  return api<AdminCataloguesPage>(`/api/admin/catalogues?${sp.toString()}`);
};

export const adminDeleteCatalogue = (categoryId: string) =>
  api<void>(`/api/admin/catalogues/${categoryId}`, { method: "DELETE" });
