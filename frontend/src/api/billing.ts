import { api } from "./client";

export type BillingStatus = {
  plan: "internal_beta" | "starter" | "professional" | "expert";
  license_key_masked: string | null;
  license_status: string | null;
  license_expires_at: string | null;
  in_grace_period: boolean;
  limits: Record<string, number | null>;
  features: string[];
  server_configured: boolean;
};

export function getBillingStatus() {
  return api<BillingStatus>("/api/billing/status");
}

export function activateLicense(license_key: string) {
  return api<BillingStatus>("/api/billing/license", {
    method: "POST",
    body: JSON.stringify({ license_key }),
  });
}

export function deactivateLicense() {
  return api<BillingStatus>("/api/billing/license", { method: "DELETE" });
}

export function refreshLicense() {
  return api<BillingStatus>("/api/billing/license/refresh", { method: "POST" });
}
