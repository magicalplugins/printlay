import { api } from "./client";

export interface FreeAsset {
  id: string;
  name: string;
  kind: "pdf" | "svg" | "png" | "jpg";
  width_pt: number;
  height_pt: number;
  width_px?: number | null;
  height_px?: number | null;
  thumbnail_url: string | null;
}

export interface FreePlacement {
  asset_id: string;
  x_mm: number;
  y_mm: number;
  rotation_deg: number;
  scale: number;
}

export async function createFreeSession(): Promise<string> {
  const res = await api<{ token: string }>("/api/free-tools/session", {
    method: "POST",
  });
  return res.token;
}

export async function uploadFreeAsset(
  token: string,
  file: File
): Promise<FreeAsset> {
  const fd = new FormData();
  fd.append("token", token);
  fd.append("file", file);
  return api<FreeAsset>("/api/free-tools/upload", { method: "POST", body: fd });
}

export async function exportFreePdf(params: {
  token: string;
  sheet_width_mm: number;
  sheet_height_mm: number;
  gap_mm: number;
  edge_margin_mm: number;
  mirror_output: boolean;
  placements: FreePlacement[];
}): Promise<Blob> {
  const resp = await fetch("/api/free-tools/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ detail: "Export failed" }));
    throw new Error(err.detail || "Export failed");
  }
  return resp.blob();
}

export async function deleteFreeSession(token: string): Promise<void> {
  await fetch(`/api/free-tools/session/${token}`, { method: "DELETE" });
}
