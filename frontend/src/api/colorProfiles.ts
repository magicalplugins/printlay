import { api } from "./client";

export type RGB = [number, number, number];

export type ColorSwap = {
  source: RGB;
  target: RGB;
  label?: string | null;
};

export type ColorProfile = {
  id: string;
  name: string;
  swaps: ColorSwap[];
  created_at: string;
  updated_at: string;
  job_count: number;
};

export type JobColorsState = {
  detected: RGB[];
  color_profile_id: string | null;
  color_swaps_draft: ColorSwap[];
  profile: ColorProfile | null;
};

export function listColorProfiles() {
  return api<ColorProfile[]>("/api/color-profiles");
}

export function getColorProfile(id: string) {
  return api<ColorProfile>(`/api/color-profiles/${id}`);
}

export function createColorProfile(payload: { name: string; swaps?: ColorSwap[] }) {
  return api<ColorProfile>("/api/color-profiles", {
    method: "POST",
    body: JSON.stringify({ swaps: [], ...payload }),
  });
}

export function updateColorProfile(
  id: string,
  payload: Partial<Pick<ColorProfile, "name" | "swaps">>
) {
  return api<ColorProfile>(`/api/color-profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteColorProfile(id: string) {
  return api<void>(`/api/color-profiles/${id}`, { method: "DELETE" });
}

export function duplicateColorProfile(id: string) {
  return api<ColorProfile>(`/api/color-profiles/${id}/duplicate`, {
    method: "POST",
  });
}

// ---- Job colour state ----

export function getJobColors(jobId: string, opts: { detect?: boolean } = {}) {
  const detect = opts.detect ?? true;
  return api<JobColorsState>(
    `/api/jobs/${jobId}/colors?detect=${detect ? "true" : "false"}`
  );
}

export type JobColorAttachPayload = {
  color_profile_id?: string | null;
  color_swaps_draft?: ColorSwap[];
  clear_profile?: boolean;
  clear_draft?: boolean;
};

export function updateJobColors(jobId: string, payload: JobColorAttachPayload) {
  return api(`/api/jobs/${jobId}/colors`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

// ---- Helpers ----

export function rgbToHex([r, g, b]: RGB): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(hex: string): RGB | null {
  const m = hex.trim().replace(/^#/, "").match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ];
}

export function rgbCss([r, g, b]: RGB): string {
  return `rgb(${r}, ${g}, ${b})`;
}

export function rgbEq(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
