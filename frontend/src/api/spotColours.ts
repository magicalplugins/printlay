import { api } from "./client";

export interface SpotColour {
  id: string;
  name: string;
  display_color: string;
  sort_order: number;
}

export function listSpotColours() {
  return api<SpotColour[]>("/api/spot-colours");
}

export function createSpotColour(data: Omit<SpotColour, "id">) {
  return api<SpotColour>("/api/spot-colours", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateSpotColour(id: string, data: Partial<SpotColour>) {
  return api<SpotColour>(`/api/spot-colours/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteSpotColour(id: string) {
  return api<void>(`/api/spot-colours/${id}`, { method: "DELETE" });
}
