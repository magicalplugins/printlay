import { api } from "./client";

export type Category = {
  id: string;
  name: string;
  created_at: string;
};

export type Asset = {
  id: string;
  category_id: string;
  name: string;
  kind: "pdf" | "svg" | "png" | "jpg";
  width_pt: number;
  height_pt: number;
  file_size: number;
  thumbnail_url: string | null;
  created_at: string;
};

export const listCategories = () => api<Category[]>("/api/categories");

export const createCategory = (name: string) =>
  api<Category>("/api/categories", {
    method: "POST",
    body: JSON.stringify({ name }),
  });

export const deleteCategory = (id: string) =>
  api<void>(`/api/categories/${id}`, { method: "DELETE" });

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
