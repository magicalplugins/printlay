import { api } from "./client";

export type Output = {
  id: string;
  job_id: string;
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
