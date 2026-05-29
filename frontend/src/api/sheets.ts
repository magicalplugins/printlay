import { api } from "./client";

// ---------- Types ----------

export interface CutterPreset {
  id: string;
  name: string;
  media_width_mm: number;
  registration_type: string | null;
  max_zone_length_mm: number | null;
  mark_offset_mm: number;
  default_gap_mm: number;
  default_edge_margin_mm: number;
  show_crop_marks: boolean;
}

export interface Placement {
  asset_id: string;
  x_mm: number;
  y_mm: number;
  rotation_deg: number;
  scale: number;
}

export interface StickerSheet {
  id: string;
  name: string;
  media_width_mm: number;
  media_height_mm: number;
  mode: "roll" | "sheet";
  sub_sheet_size: string | null;
  gap_mm: number;
  sub_sheet_gap_mm: number;
  sub_sheet_padding_mm: number;
  edge_margin_mm: number;
  show_crop_marks: boolean;
  registration_type: string | null;
  max_zone_length_mm: number | null;
  mark_offset_mm: number;
  placements: Placement[] | null;
  cutter_preset_id: string | null;
  sub_sheet_fill_color: string | null;
  sub_sheet_fill_color2: string | null;
  sub_sheet_gradient_angle: number | null;
  sub_sheet_bg_url: string | null;
  sub_sheet_title: string | null;
  sub_sheet_title_font: string | null;
  sub_sheet_title_size_mm: number | null;
  sticker_align_h: string | null;
  sticker_align_v: string | null;
  sub_sheet_bleed_mm: number | null;
  output_url: string | null;
}

export interface AutoLayoutResult {
  placements: Placement[];
  total_height_mm: number;
  cols: number;
  rows: number;
  zones: number;
}

// ---------- Cutter Presets ----------

export function listPresets() {
  return api<CutterPreset[]>("/api/sheets/presets");
}

export function createPreset(data: Omit<CutterPreset, "id">) {
  return api<CutterPreset>("/api/sheets/presets", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function deletePreset(id: string) {
  return api<void>(`/api/sheets/presets/${id}`, { method: "DELETE" });
}

// ---------- Sticker Sheets ----------

export function listSheets() {
  return api<StickerSheet[]>("/api/sheets");
}

export function createSheet(data: Partial<StickerSheet>) {
  return api<StickerSheet>("/api/sheets", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateSheet(id: string, data: Partial<StickerSheet>) {
  return api<StickerSheet>(`/api/sheets/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteSheet(id: string) {
  return api<void>(`/api/sheets/${id}`, { method: "DELETE" });
}

export function autoLayout(
  sheetId: string,
  assetId: string,
  quantity: number,
  orientation: "auto" | "horizontal" | "vertical" = "auto"
) {
  return api<AutoLayoutResult>(`/api/sheets/${sheetId}/auto-layout`, {
    method: "POST",
    body: JSON.stringify({ asset_id: assetId, quantity, orientation }),
  });
}

export function exportSheetPdf(sheetId: string): Promise<Blob> {
  return api<Blob>(`/api/sheets/${sheetId}/export`, {
    method: "POST",
    headers: { Accept: "application/pdf" },
  });
}
