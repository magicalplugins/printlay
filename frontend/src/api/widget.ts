import { api } from "./client";

// Cut styles available to a sticker product.
export const CUT_STYLES = [
  { key: "die_cut", label: "Die-cut (around subject)" },
  { key: "face", label: "Face cut" },
  { key: "keep_bg", label: "Keep background (cut around image)" },
  { key: "square", label: "Square / rounded" },
  { key: "circle", label: "Circle / oval" },
] as const;

export type CutStyle = (typeof CUT_STYLES)[number]["key"];

// Which cut styles each design experience allows. Cut-out products do contour
// and face cuts, plus "keep background" (a rectangle cut around the uploaded
// image, no background removal); shaped (canvas) products do geometric artboard
// shapes (rectangle/oval are reached via the in-designer unlock toggle).
export const CUT_STYLES_BY_DESIGNER: Record<"cutout" | "canvas", CutStyle[]> = {
  cutout: ["die_cut", "face", "keep_bg"],
  canvas: ["square", "circle"],
};

// ---- API keys -------------------------------------------------------------
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}
export interface ApiKeyCreated extends ApiKey {
  plaintext: string;
}

export const listKeys = () => api<ApiKey[]>("/api/widget/keys");
export const createKey = (name: string) =>
  api<ApiKeyCreated>("/api/widget/keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
export const revokeKey = (id: string) =>
  api<void>(`/api/widget/keys/${id}`, { method: "DELETE" });

// ---- Settings -------------------------------------------------------------
export interface WidgetSettings {
  allowed_origins: string[];
  has_webhook_secret: boolean;
}
export const getWidgetSettings = () => api<WidgetSettings>("/api/widget/settings");
export const updateWidgetSettings = (allowed_origins: string[]) =>
  api<WidgetSettings>("/api/widget/settings", {
    method: "PATCH",
    body: JSON.stringify({ allowed_origins }),
  });
export const rotateWebhookSecret = () =>
  api<{ webhook_secret: string }>("/api/widget/settings/webhook-secret", {
    method: "POST",
  });

// ---- Pricing profiles -----------------------------------------------------
export interface QuantityBreak {
  min_qty: number;
  discount_pct: number;
}
export interface PricingProfile {
  id: string;
  name: string;
  currency: string;
  sheet_width_mm: number;
  price_per_metre: number;
  gap_mm: number;
  margin_pct: number;
  handling_fee: number;
  min_order_price: number;
  min_length_m: number;
  vinyl_surcharges: Record<string, number> | null;
  finish_surcharges: Record<string, number> | null;
  quantity_breaks: QuantityBreak[] | null;
  quantity_presets: number[] | null;
  allow_custom_quantity: boolean;
  created_at: string;
}
export type PricingProfileInput = Omit<PricingProfile, "id" | "created_at">;

export const listPricingProfiles = () =>
  api<PricingProfile[]>("/api/widget/pricing-profiles");
export const createPricingProfile = (body: PricingProfileInput) =>
  api<PricingProfile>("/api/widget/pricing-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updatePricingProfile = (id: string, body: PricingProfileInput) =>
  api<PricingProfile>(`/api/widget/pricing-profiles/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const deletePricingProfile = (id: string) =>
  api<void>(`/api/widget/pricing-profiles/${id}`, { method: "DELETE" });

// ---- Products -------------------------------------------------------------
export interface VinylOption {
  key: string;
  label: string;
}
export type DesignerMode = "cutout" | "canvas";

export interface SizePreset {
  width_mm: number;
  height_mm: number;
}

export interface Product {
  id: string;
  name: string;
  is_active: boolean;
  designer: DesignerMode;
  enabled_cut_styles: CutStyle[];
  min_size_mm: number;
  max_size_mm: number;
  size_presets: SizePreset[];
  allow_custom_size: boolean;
  corner_radius: number;
  vinyl_types: VinylOption[];
  finishes: VinylOption[];
  bleed_mm: number;
  safe_mm: number;
  show_filters: boolean;
  show_ai_styles: boolean;
  show_hand_edit: boolean;
  require_proof: boolean;
  proof_fee: number;
  pricing_profile_id: string | null;
  created_at: string;
}
export type ProductInput = Omit<Product, "id" | "created_at">;

export const listProducts = () => api<Product[]>("/api/widget/products");
export const getProduct = (id: string) => api<Product>(`/api/widget/products/${id}`);
export const createProduct = (body: ProductInput) =>
  api<Product>("/api/widget/products", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateProduct = (id: string, body: ProductInput) =>
  api<Product>(`/api/widget/products/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const deleteProduct = (id: string) =>
  api<void>(`/api/widget/products/${id}`, { method: "DELETE" });

// ---- Print orders ---------------------------------------------------------
export interface PrintOrder {
  id: string;
  platform: string;
  external_order_id: string;
  customer_ref: string | null;
  line_items: Array<Record<string, unknown>>;
  amount_total: number;
  currency: string;
  status: "draft" | "paid" | "ready_to_print" | "printed";
  proof_status: string | null;
  proof_notes: string | null;
  proof_history: Array<{ action: string; timestamp: string; by: string; message: string }> | null;
  customer_email: string | null;
  proof_token: string | null;
  output_r2_key: string | null;
  created_at: string;
}
export const listOrders = (status?: string) =>
  api<PrintOrder[]>(
    `/api/widget/orders${status ? `?status_filter=${encodeURIComponent(status)}` : ""}`
  );
export const updateOrderStatus = (id: string, status: PrintOrder["status"]) =>
  api<PrintOrder>(`/api/widget/orders/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
  });
export const deleteOrder = (id: string) =>
  api<void>(`/api/widget/orders/${id}`, { method: "DELETE" });

export const sendProof = (id: string) =>
  api<PrintOrder>(`/api/widget/orders/${id}/send-proof`, { method: "POST" });

// ---- Live preview ---------------------------------------------------------
export const createPreviewSession = (product_id: string) =>
  api<{ session_token: string; expires_in: number }>("/api/widget/preview-session", {
    method: "POST",
    body: JSON.stringify({ product_id }),
  });
