import { api } from "./client";

export type Category = {
  id: string;
  name: string;
  created_at: string;
  is_official?: boolean;
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

export type BulkDeleteResult = { deleted: number; skipped: number };

/** Delete many assets in one round-trip. Capped at 500 ids server-side.
 *  Skipped count covers ids the caller doesn't own (e.g. stale cache);
 *  those are silently ignored. */
export const bulkDeleteAssets = (assetIds: string[]) =>
  api<BulkDeleteResult>("/api/assets/bulk-delete", {
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
