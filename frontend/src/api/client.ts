import { getImpersonation } from "../auth/impersonation";
import { getSupabase } from "../auth/supabase";

export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`${status}`);
  }
}

/** Pull a human-readable message out of a thrown API error. FastAPI puts
 *  the reason in `detail`; ApiError carries the parsed body. */
export function apiErrMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const b = e.body;
    if (b && typeof b === "object" && "detail" in b) {
      const detail = (b as { detail: unknown }).detail;
      if (detail && typeof detail === "object" && "message" in detail) {
        return String((detail as { message: string }).message);
      }
      return String(detail);
    }
    if (typeof b === "string" && b) return b;
    return `Request failed (${e.status})`;
  }
  return e instanceof Error ? e.message : String(e);
}

/** HTTP statuses that almost always reflect a transient outage rather
 *  than a real client/server bug: a backend rolling restart, a load-
 *  balancer reconnecting, a single Fly machine briefly out of capacity.
 *  Safe to retry the original request a moment later. */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

/** Per-attempt backoff in ms. Total worst-case latency before surfacing
 *  the failure: ~2 seconds (300 + 700 + 1500) on top of the original
 *  attempt — long enough to absorb a deploy rollover, short enough not
 *  to keep the user staring at a spinner. */
const RETRY_DELAYS_MS = [300, 700, 1500];

function isIdempotent(method?: string): boolean {
  // Default fetch method is GET. Safe methods + DELETE (delete-by-id
  // is naturally idempotent: deleting an already-deleted row just 404s).
  const m = (method || "GET").toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "DELETE";
}

function shouldRetry(err: unknown, attemptsLeft: number): boolean {
  if (attemptsLeft <= 0) return false;
  if (err instanceof ApiError) {
    return TRANSIENT_STATUSES.has(err.status);
  }
  // `TypeError: Failed to fetch` (Chromium) / `NetworkError` (Firefox) —
  // typical signal that the connection dropped mid-flight.
  return err instanceof TypeError;
}

export async function api<T = unknown>(
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("Content-Type") && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }

  const supabase = await getSupabase().catch(() => null);
  if (supabase) {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
  }

  const imp = getImpersonation();
  if (imp && !path.includes("/api/admin/") && !path.includes("/api/billing")) {
    headers.set("X-Impersonate", imp.userId);
  }

  const url = path.startsWith("/") ? path : `/${path}`;
  const retryable = isIdempotent(init.method);
  const maxAttempts = retryable ? 1 + RETRY_DELAYS_MS.length : 1;

  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      // Honour a Retry-After hint when the server set one (e.g. our
      // sticker-processing semaphore returns 503 with Retry-After: 10),
      // otherwise use the per-attempt default backoff.
      const retryAfter =
        lastErr instanceof ApiError
          ? Number((lastErr.body as { __retryAfter?: number })?.__retryAfter)
          : NaN;
      const wait =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 5000)
          : RETRY_DELAYS_MS[attempt - 1];
      await new Promise((r) => setTimeout(r, wait));
    }

    try {
      const res = await fetch(url, { ...init, headers });
      if (!res.ok) {
        const text = await res.text();
        let body: unknown = text;
        if (text) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        const err = new ApiError(res.status, body);
        if (retryable && shouldRetry(err, maxAttempts - attempt - 1)) {
          lastErr = err;
          continue;
        }
        throw err;
      }
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text ? JSON.parse(text) : undefined) as T;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (retryable && shouldRetry(e, maxAttempts - attempt - 1)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  // Out of retries — surface the last transient error so the page can
  // render its retry UI instead of looping forever.
  throw lastErr ?? new Error("Request failed");
}
