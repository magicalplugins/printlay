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

/** AI illustration styles available in the sticker builder. These run
 *  on the user's own OpenAI key (set in Settings → Preferences). */
export const AI_STYLES: { id: string; label: string; blurb: string }[] = [
  { id: "cartoon", label: "Cartoon", blurb: "Clean cartoon illustration" },
  { id: "caricature", label: "Caricature", blurb: "Funny exaggerated features" },
  { id: "pencil", label: "Pencil", blurb: "Hand-drawn pencil sketch" },
  { id: "anime", label: "Anime", blurb: "Anime / manga style" },
  { id: "popart", label: "Pop art", blurb: "Bold comic-book look" },
  { id: "watercolor", label: "Watercolour", blurb: "Soft painted look" },
];

/** AI photo retouch — photorealistic enhancements (keeps it a photo).
 *  Same OpenAI-key gating as AI_STYLES. */
export const AI_RETOUCH: { id: string; label: string; blurb: string }[] = [
  { id: "retouch", label: "Beautify", blurb: "Full natural retouch" },
  { id: "smoothskin", label: "Smooth skin", blurb: "Even, flawless skin" },
  { id: "brighteyes", label: "Brighten eyes", blurb: "Brighter, sharper eyes" },
];

export async function aiStyleSticker(
  sessionId: string,
  style: string,
  borderWidthMm: number = 2.0,
  bleedMm: number = 3.0,
  cutlineMode: string = "contour",
  customPrompt?: string
): Promise<ProcessResponse> {
  return api<ProcessResponse>("/api/sticker/ai-style", {
    method: "POST",
    body: JSON.stringify({
      session_id: sessionId,
      style,
      custom_prompt: customPrompt ?? null,
      border_width_mm: borderWidthMm,
      bleed_mm: bleedMm,
      cutline_mode: cutlineMode,
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

export interface ResumeResponse {
  session_id: string;
  cutout_url: string;
  border_url: string;
  preview_url: string;
  source_url: string | null;
  cutline_points: [number, number][];
  img_w_px: number;
  img_h_px: number;
  width_mm: number;
  height_mm: number;
  work_dpi: number;
}

export async function resumeSticker(assetId: string): Promise<ResumeResponse> {
  return api<ResumeResponse>(`/api/sticker/resume/${assetId}`);
}
