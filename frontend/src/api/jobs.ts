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
};

export function applyJobQueue(id: string, queue: QueueItem[]) {
  return api<Job>(`/api/jobs/${id}/queue`, {
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
  created_at: string;
  color_swap_report: ColorSwapReport | null;
};

export function generateOutput(id: string) {
  return api<GenerateResponse>(`/api/jobs/${id}/generate`, { method: "POST" });
}
