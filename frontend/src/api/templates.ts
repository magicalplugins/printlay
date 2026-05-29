import { api } from "./client";

export type Shape = {
  page_index: number;
  shape_index: number;
  bbox: [number, number, number, number];
  layer: string | null;
  is_position_slot: boolean;
  /** Geometric kind. `"rect"` (default), `"ellipse"` (covers circles too)
   *  or `"polygon"` (hexagons, octagons, stars, custom die-cut shapes). */
  kind?: "rect" | "ellipse" | "polygon";
  /** Corner radius in PDF points. Only meaningful when `kind === "rect"`. */
  corner_radius_pt?: number;
  /** Polygon vertices normalised to the bbox: each `[u, v]` is in `[0, 1]`
   *  where `[0, 0]` = bbox top-left, `[1, 1]` = bbox bottom-right.
   *  Only present (and only meaningful) when `kind === "polygon"`. */
  path?: [number, number][];
};

export type SpacingMode = "fixed" | "even";

export type RegistrationType = "velloblade" | "summa_opos" | "generic";

export type Template = {
  id: string;
  name: string;
  source: "uploaded" | "generated";
  units: string;
  page_width: number;
  page_height: number;
  positions_layer: string;
  has_ocg: boolean;
  bleed_mm: number;
  safe_mm: number;
  /** Cutter registration marks baked into every output generated from
   *  this template. `null` = no marks. */
  registration_type: RegistrationType | null;
  mark_offset_mm: number;
  max_zone_length_mm: number | null;
  shapes: Shape[];
  generation_params: Record<string, unknown> | null;
  created_at: string;
};

export type TemplateUpdate = {
  name?: string;
  bleed_mm?: number;
  safe_mm?: number;
  registration_type?: RegistrationType | null;
  mark_offset_mm?: number;
  max_zone_length_mm?: number | null;
};

export function updateTemplate(id: string, patch: TemplateUpdate) {
  return api<Template>(`/api/templates/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

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
    /** `circle` is the equal-W/H special case rendered with a single
     *  diameter input; `ellipse` takes independent width × height and
     *  draws an oval. Both round-trip from the parser as `kind: "ellipse"`. */
    kind: "rect" | "circle" | "ellipse";
    width: number;
    height: number;
    gap_x: number;
    gap_y: number;
    center: boolean;
    edge_margin: number;
    corner_radius?: number;
    spacing_mode: SpacingMode;
  };
  registration_type?: RegistrationType | null;
  mark_offset_mm?: number;
  max_zone_length_mm?: number | null;
};

export function generateTemplate(req: GenerateRequest) {
  return api<Template>("/api/templates/generate", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

export function reparseTemplate(id: string) {
  return api<Template>(`/api/templates/${id}/reparse`, { method: "POST" });
}

export function deleteTemplate(id: string) {
  return api<void>(`/api/templates/${id}`, { method: "DELETE" });
}

export function downloadTemplateUrl(id: string) {
  return api<{ url: string; expires_in: number }>(
    `/api/templates/${id}/download`
  );
}
