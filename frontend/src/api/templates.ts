import { api } from "./client";

export type Shape = {
  page_index: number;
  shape_index: number;
  bbox: [number, number, number, number];
  layer: string | null;
  is_position_slot: boolean;
};

export type SpacingMode = "fixed" | "even";

export type Template = {
  id: string;
  name: string;
  source: "uploaded" | "generated";
  units: string;
  page_width: number;
  page_height: number;
  positions_layer: string;
  has_ocg: boolean;
  shapes: Shape[];
  generation_params: Record<string, unknown> | null;
  created_at: string;
};

export function listTemplates() {
  return api<Template[]>("/api/templates");
}

export function getTemplate(id: string) {
  return api<Template>(`/api/templates/${id}`);
}

export async function uploadTemplate(file: File, name?: string) {
  const fd = new FormData();
  fd.append("file", file);
  if (name) fd.append("name", name);
  const url = name
    ? `/api/templates/upload?name=${encodeURIComponent(name)}`
    : "/api/templates/upload";
  return api<Template>(url, { method: "POST", body: fd });
}

export type GenerateRequest = {
  name: string;
  artboard: { width: number; height: number; units: "mm" | "pt" | "in" };
  shape: {
    kind: "rect" | "circle";
    width: number;
    height: number;
    gap_x: number;
    gap_y: number;
    center: boolean;
    edge_margin: number;
    spacing_mode: SpacingMode;
  };
};

export function generateTemplate(req: GenerateRequest) {
  return api<Template>("/api/templates/generate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function deleteTemplate(id: string) {
  return api<void>(`/api/templates/${id}`, { method: "DELETE" });
}

export function downloadTemplateUrl(id: string) {
  return api<{ url: string; expires_in: number }>(
    `/api/templates/${id}/download`
  );
}
