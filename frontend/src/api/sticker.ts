import { api } from "./client";

export interface ProcessResponse {
  preview_url: string;
  border_url: string;
  cutout_url?: string;
  width_mm: number;
  height_mm: number;
  bg_type: string;
  removal_method: string | null;
  session_id: string;
  cutline_points: [number, number][];
  img_w_px: number;
  img_h_px: number;
}

export interface SaveResponse {
  asset_id: string;
  thumbnail_url: string;
}

export interface UsageResponse {
  used: number;
  limit: number | null;
  plan: string;
}

export interface StickerLook {
  filterId?: string;
  beautifySmooth?: number; // 0..1
  beautifyEyes?: number; // 0..1
  beautifyTone?: number; // 0..1
}

export async function processSticker(
  file: File,
  method: string = "auto",
  borderWidthMm: number = 5.0,
  cutlineMode: string = "contour",
  cutlinePrecision: string = "medium",
  bleedMm: number = 3.0
): Promise<ProcessResponse> {
  const form = new FormData();
  form.append("file", file);
  form.append("method", method);
  form.append("border_width_mm", String(borderWidthMm));
  form.append("bleed_mm", String(bleedMm));
  form.append("cutline_mode", cutlineMode);
  form.append("cutline_precision", cutlinePrecision);
  return api<ProcessResponse>("/api/sticker/process", {
    method: "POST",
    body: form,
  });
}

export async function regenerateSticker(
  sessionId: string,
  cutlineMode: string,
  cutlinePrecision: string,
  borderWidthMm: number = 2.0,
  bleedMm: number = 3.0,
  look: StickerLook = {}
): Promise<ProcessResponse> {
  return api<ProcessResponse>("/api/sticker/regenerate", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      cutline_mode: cutlineMode,
      cutline_precision: cutlinePrecision,
      border_width_mm: borderWidthMm,
      bleed_mm: bleedMm,
      filter_id: look.filterId ?? "none",
      beautify_smooth: look.beautifySmooth ?? 0,
      beautify_eyes: look.beautifyEyes ?? 0,
      beautify_tone: look.beautifyTone ?? 0,
    }),
  });
}

export async function editCutline(
  sessionId: string,
  points: [number, number][]
): Promise<ProcessResponse> {
  return api<ProcessResponse>("/api/sticker/edit-cutline", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      points,
    }),
  });
}

export async function saveSticker(
  sessionId: string,
  name: string = "Sticker",
  categoryId?: string | null,
  includeCutContour: boolean = true
): Promise<SaveResponse> {
  return api<SaveResponse>("/api/sticker/save", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      name,
      category_id: categoryId ?? null,
      include_cut_contour: includeCutContour,
    }),
  });
}

export async function getStickerUsage(): Promise<UsageResponse> {
  return api<UsageResponse>("/api/sticker/usage");
}
