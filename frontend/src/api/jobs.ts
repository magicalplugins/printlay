import { api } from "./client";
import type { Asset } from "./catalogue";
import type { ColorSwap } from "./colorProfiles";

export type JobAssignment = {
  asset_id: string;
  asset_kind?: string | null;
  asset_name?: string | null;
  rotation_deg?: number;
  fit_mode?: "contain" | "cover" | "stretch" | "manual";
  x_mm?: number;
  y_mm?: number;
  w_mm?: number | null;
  h_mm?: number | null;
  filter_id?: string;
  /** Non-destructive "safe crop" frame. When true, the printable area
   *  shrinks from slot+bleed down to slot-safe; everything outside the
   *  safe rect renders as a uniform white border. Lets users design
   *  freely and "frame" the result with one click as a finishing step. */
  safe_crop?: boolean;
  /** Which page/artboard of the source PDF to render in this slot.
   *  Defaults to 0. Only meaningful for multi-page PDFs (e.g. double-
   *  sided sticker artwork) — other slots can pick different pages off
   *  the same asset. */
  page_index?: number;
};

export type Job = {
  id: string;
  template_id: string;
  name: string;
  slot_order: number[];
  assignments: Record<string, JobAssignment>;
  created_at: string;
  color_profile_id?: string | null;
  color_swaps_draft?: ColorSwap[] | null;
};

export function listJobs() {
  return api<Job[]>("/api/jobs");
}

export function getJob(id: string) {
  return api<Job>(`/api/jobs/${id}`);
}

export function createJob(payload: {
  template_id: string;
  name: string;
  slot_order?: number[];
  assignments?: Record<string, JobAssignment>;
}) {
  return api<Job>("/api/jobs", {
    method: "POST",
    body: JSON.stringify({
      slot_order: [],
      assignments: {},
      ...payload,
    }),
  });
}

export function updateJob(
  id: string,
  payload: Partial<Pick<Job, "name" | "slot_order" | "assignments">>
) {
  return api<Job>(`/api/jobs/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteJob(id: string) {
  return api<void>(`/api/jobs/${id}`, { method: "DELETE" });
}

export function fillJob(id: string, asset_id: string, quantity: number) {
  return api<Job>(`/api/jobs/${id}/fill`, {
    method: "POST",
    body: JSON.stringify({ asset_id, quantity }),
  });
}

export type QueueItem = {
  asset_id: string;
  quantity: number;
  rotation_deg?: number;
  fit_mode?: "contain" | "cover" | "stretch" | "manual";
  x_mm?: number;
  y_mm?: number;
  w_mm?: number | null;
  h_mm?: number | null;
  filter_id?: string;
  safe_crop?: boolean;
  page_index?: number;
};

export interface QueueResult extends Job {
  _warning?: string;
}

export function applyJobQueue(id: string, queue: QueueItem[]) {
  return api<QueueResult>(`/api/jobs/${id}/queue`, {
    method: "POST",
    body: JSON.stringify({ queue }),
  });
}

export function listJobUploads(id: string) {
  return api<Asset[]>(`/api/jobs/${id}/uploads`);
}

export async function uploadJobAsset(id: string, file: File, name?: string) {
  const fd = new FormData();
  fd.append("file", file);
  if (name) fd.append("name", name);
  return api<Asset>(`/api/jobs/${id}/uploads`, { method: "POST", body: fd });
}

export function deleteJobUpload(jobId: string, assetId: string) {
  return api<void>(`/api/jobs/${jobId}/uploads/${assetId}`, { method: "DELETE" });
}

export function duplicateJob(id: string) {
  return api<Job>(`/api/jobs/${id}/duplicate`, { method: "POST" });
}

export type ColorSwapReport = {
  swaps_applied: number;
  by_color: Record<string, number>;
  gradients_skipped: number;
  raster_skipped: number;
  unmatched: string[];
};

export type GenerateResponse = {
  id: string;
  job_id: string;
  name: string;
  file_size: number;
  slots_filled: number;
  slots_total: number;
  status: "ready" | "processing" | "failed";
  created_at: string;
  color_swap_report: ColorSwapReport | null;
};

export type GenerateOptions = {
  include_cut_lines?: boolean;
  /** Cut-line spot colour: a spot name (`CutContour`) or a `#hex`. */
  cut_line_spot_color?: string | null;
  /** Registration-mark spot colour (name or `#hex`). The mark *type* is
   *  baked into the template. */
  mark_spot_color?: string | null;
};

export async function exportJobSvg(
  id: string,
  opts: { cut_color?: string; mark_color?: string } = {}
): Promise<Blob> {
  const { getSupabase } = await import("../auth/supabase");
  const supabase = await getSupabase().catch(() => null);
  const headers: Record<string, string> = { Accept: "image/svg+xml" };
  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token)
      headers["Authorization"] = `Bearer ${session.access_token}`;
  }
  const params = new URLSearchParams();
  if (opts.cut_color) params.set("cut_color", opts.cut_color);
  if (opts.mark_color) params.set("mark_color", opts.mark_color);
  const res = await fetch(`/api/jobs/${id}/export-svg?${params.toString()}`, {
    method: "POST",
    headers,
  });
  if (!res.ok) throw new Error(`Export failed: ${res.status}`);
  return res.blob();
}

export function generateOutput(id: string, options: GenerateOptions = {}) {
  // Backwards-compatible: an empty options object means "no body", which
  // the FastAPI route treats as the default behaviour (no cut lines,
  // existing colour-swap pipeline only).
  const hasAny =
    options.include_cut_lines === true ||
    options.cut_line_spot_color != null ||
    options.mark_spot_color != null;
  return api<GenerateResponse>(`/api/jobs/${id}/generate`, {
    method: "POST",
    body: hasAny
      ? JSON.stringify({
          include_cut_lines: !!options.include_cut_lines,
          cut_line_spot_color: options.cut_line_spot_color ?? null,
          mark_spot_color: options.mark_spot_color ?? null,
        })
      : undefined,
  });
}

export function pollOutputStatus(outputId: string) {
  return api<GenerateResponse>(`/api/outputs/${outputId}/status`);
}
