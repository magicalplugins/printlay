import { api } from "./client";

export type JobAssignment = {
  asset_id: string;
  asset_kind?: string | null;
  asset_name?: string | null;
};

export type Job = {
  id: string;
  template_id: string;
  name: string;
  slot_order: number[];
  assignments: Record<string, JobAssignment>;
  created_at: string;
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

export function duplicateJob(id: string) {
  return api<Job>(`/api/jobs/${id}/duplicate`, { method: "POST" });
}

export function generateOutput(id: string) {
  return api<{
    id: string;
    job_id: string;
    name: string;
    file_size: number;
    slots_filled: number;
    slots_total: number;
    created_at: string;
  }>(`/api/jobs/${id}/generate`, { method: "POST" });
}
