import { api } from "./client";

export type RGB = [number, number, number];

export type SpotColor = {
  id: string;
  name: string;
  rgb: RGB;
  is_cut_line_default: boolean;
  created_at: string;
  updated_at: string;
};

export function listSpotColors() {
  return api<SpotColor[]>("/api/spot-colors");
}

export function createSpotColor(payload: {
  name: string;
  rgb: RGB;
  is_cut_line_default?: boolean;
}) {
  return api<SpotColor>("/api/spot-colors", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSpotColor(
  id: string,
  payload: Partial<Pick<SpotColor, "name" | "rgb" | "is_cut_line_default">>
) {
  return api<SpotColor>(`/api/spot-colors/${id}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

export function deleteSpotColor(id: string) {
  return api<void>(`/api/spot-colors/${id}`, { method: "DELETE" });
}
