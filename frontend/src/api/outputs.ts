import { api } from "./client";

export type Output = {
  id: string;
  job_id: string | null;
  sheet_id: string | null;
  source_type: "job" | "sheet" | "dtf_sheet";
  name: string;
  file_size: number;
  slots_filled: number;
  slots_total: number;
  created_at: string;
};

export const listOutputs = () => api<Output[]>("/api/outputs");

export const downloadOutputUrl = (id: string) =>
  api<{ url: string; expires_in: number }>(`/api/outputs/${id}/download`);

export const deleteOutput = (id: string) =>
  api<void>(`/api/outputs/${id}`, { method: "DELETE" });

export const bulkDeleteOutputs = (ids: string[]) =>
  api<void>("/api/outputs/bulk-delete", {
    method: "POST",
    body: JSON.stringify({ ids }),
  });
