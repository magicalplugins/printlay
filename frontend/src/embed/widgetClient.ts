/**
 * Minimal API client for the embeddable sticker widget.
 *
 * Unlike the main app `api()` helper, this authenticates with the short-lived
 * widget SESSION TOKEN (minted server-side from a merchant API key, or by the
 * admin preview endpoint) — never the merchant key, never a Supabase JWT. All
 * paths are relative, so the iframe always talks to the Printlay origin it was
 * served from regardless of which store embeds it.
 */

export interface ProductConfig {
  id: string;
  name: string;
  mode: "flexible" | "fixed";
  designer: "cutout" | "canvas";
  enabled_cut_styles: string[];
  min_size_mm: number;
  max_size_mm: number;
  size_presets: { width_mm: number; height_mm: number }[];
  allow_custom_size: boolean;
  corner_radius: number;
  vinyl_types: { key: string; label: string }[];
  finishes: { key: string; label: string }[];
  bleed_mm: number;
  safe_mm: number;
  currency: string;
  show_filters?: boolean;
  show_ai_styles?: boolean;
  show_hand_edit?: boolean;
}

export interface ProcessResult {
  preview_url: string;
  border_url: string;
  cutout_url: string;
  width_mm: number;
  height_mm: number;
  bg_type: string;
  removal_method: string | null;
  session_id: string;
  cutline_points: [number, number][];
  img_w_px: number;
  img_h_px: number;
}

export interface PriceBreakdown {
  currency: string;
  quantity: number;
  unit_price: number;
  total: number;
  length_m: number;
  per_row: number;
  rows: number;
  quantity_discount_pct: number;
}

export interface EstimateResult {
  breakdown: PriceBreakdown;
  quote_token: string;
}

export interface FinalizeResult {
  design_ref: string;
  quote_token: string;
  total: number;
  currency: string;
  options: Record<string, unknown>;
  thumbnail_url?: string | null;
}

export class WidgetApiError extends Error {
  constructor(public status: number, public detail: string) {
    super(detail);
  }
}

export class WidgetClient {
  constructor(private token: string) {}

  private headers(json = true): HeadersInit {
    const h: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async handle<T>(res: Response): Promise<T> {
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const body = await res.json();
        if (body?.detail) detail = String(body.detail);
      } catch {
        /* non-json error body */
      }
      throw new WidgetApiError(res.status, detail);
    }
    if (res.status === 204) return undefined as T;
    return res.json() as Promise<T>;
  }

  config() {
    return fetch("/api/v1/widget/config", { headers: this.headers() }).then((r) =>
      this.handle<ProductConfig>(r)
    );
  }

  process(file: File, cutStyle: string, filterId = "none") {
    const form = new FormData();
    form.append("file", file);
    form.append("cut_style", cutStyle);
    form.append("filter_id", filterId);
    return fetch("/api/v1/widget/process", {
      method: "POST",
      headers: this.headers(false),
      body: form,
    }).then((r) => this.handle<ProcessResult>(r));
  }

  regenerate(cutStyle: string, tighten = 0, filterId = "none", cornerRadius = 0.01) {
    return fetch("/api/v1/widget/regenerate", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        cut_style: cutStyle,
        tighten,
        filter_id: filterId,
        corner_radius: cornerRadius,
      }),
    }).then((r) => this.handle<ProcessResult>(r));
  }

  editCutline(points: [number, number][]) {
    return fetch("/api/v1/widget/edit-cutline", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ points }),
    }).then((r) => this.handle<ProcessResult>(r));
  }

  aiStyle(style: string, customPrompt?: string) {
    return fetch("/api/v1/widget/ai-style", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ style, custom_prompt: customPrompt || null }),
    }).then((r) => this.handle<ProcessResult>(r));
  }

  estimate(input: {
    width_mm: number;
    height_mm: number;
    quantity: number;
    cut_style: string;
    vinyl?: string | null;
    finish?: string | null;
    corner_radius?: number;
  }) {
    return fetch("/api/v1/widget/estimate", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(input),
    }).then((r) => this.handle<EstimateResult>(r));
  }

  finalize(quoteToken: string, name?: string) {
    return fetch("/api/v1/widget/finalize", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ quote_token: quoteToken, name }),
    }).then((r) => this.handle<FinalizeResult>(r));
  }

  removeBg(file: File) {
    const form = new FormData();
    form.append("file", file);
    return fetch("/api/v1/widget/remove-bg", {
      method: "POST",
      headers: this.headers(false),
      body: form,
    }).then((r) => this.handle<{ image_url: string; removed: boolean }>(r));
  }

  canvasFinalize(input: {
    printImage: File;
    quoteToken: string;
    shape: "rect" | "ellipse";
    name?: string;
  }) {
    const form = new FormData();
    form.append("print_image", input.printImage);
    form.append("quote_token", input.quoteToken);
    form.append("shape", input.shape);
    if (input.name) form.append("name", input.name);
    return fetch("/api/v1/widget/canvas-finalize", {
      method: "POST",
      headers: this.headers(false),
      body: form,
    }).then((r) => this.handle<FinalizeResult>(r));
  }
}

/** Read the session token from the iframe URL (`?token=...`). */
export function tokenFromUrl(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("token");
}
