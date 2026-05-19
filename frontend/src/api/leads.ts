import { api } from "./client";

export type LeadSubmit = {
  name: string;
  email: string;
  message: string;
  page_url?: string;
};

export const submitLead = (payload: LeadSubmit) =>
  api<{ ok: boolean }>("/api/leads", {
    method: "POST",
    body: JSON.stringify(payload),
  });
