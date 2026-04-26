import { ApiError } from "../api/client";

/**
 * Structured shape that the backend returns for quota / plan errors
 * (HTTP 402) — see backend/routers/* for the producers. We don't
 * require every field; older code paths still return plain strings.
 */
export type ApiErrorDetail = {
  code?:
    | "quota_exceeded"
    | "plan_locked"
    | (string & {}); // open-ended for forward compat
  message?: string;
  limit?: string;
  cap?: number | null;
};

export type FormattedApiError = {
  /** Always safe to display. */
  message: string;
  /** HTTP status code, when known. */
  status?: number;
  /** Structured backend code (e.g. "quota_exceeded"). */
  code?: string;
  /** Which entitlement limit was hit, e.g. "templates_max". */
  limit?: string;
  /** The cap value the user is up against (null = unlimited / unknown). */
  cap?: number | null;
  /** True for any 4xx that should suggest an upgrade. */
  suggestsUpgrade: boolean;
};

/**
 * Pull a human-readable message and (when present) structured upgrade
 * metadata out of any error thrown by the API client.
 *
 * The backend returns one of three shapes for `ApiError.body`:
 *
 *   1.  string                              – legacy plain detail
 *   2.  { detail: string }                  – FastAPI default
 *   3.  { detail: { code, message, ... } }  – our quota / plan errors
 *
 * The old `formatErr()` helpers stringified shape 3 to "[object Object]",
 * which hid the upgrade nudge from users hitting their cap. This is
 * the single replacement.
 */
export function formatApiError(err: unknown): FormattedApiError {
  if (err instanceof ApiError) {
    const body = err.body as
      | string
      | { detail?: string | ApiErrorDetail }
      | null;

    let detail: string | ApiErrorDetail | undefined;
    if (typeof body === "string") {
      detail = body;
    } else if (body && typeof body === "object" && "detail" in body) {
      detail = body.detail;
    }

    if (detail && typeof detail === "object") {
      const d = detail as ApiErrorDetail;
      return {
        message:
          d.message?.trim() ||
          (d.code ? `Error ${err.status} (${d.code})` : `Error ${err.status}`),
        status: err.status,
        code: d.code,
        limit: d.limit,
        cap: d.cap ?? null,
        suggestsUpgrade:
          err.status === 402 ||
          d.code === "quota_exceeded" ||
          d.code === "plan_locked",
      };
    }

    if (typeof detail === "string" && detail.trim()) {
      return {
        message: detail,
        status: err.status,
        suggestsUpgrade: err.status === 402,
      };
    }

    return {
      message: `Error ${err.status}`,
      status: err.status,
      suggestsUpgrade: err.status === 402,
    };
  }

  if (err instanceof Error) {
    return { message: err.message, suggestsUpgrade: false };
  }
  return { message: String(err), suggestsUpgrade: false };
}

/**
 * Thin wrapper for callers that just want the string. New code should
 * prefer `formatApiError()` so we can render an upgrade CTA when
 * `suggestsUpgrade === true`.
 */
export function formatErr(err: unknown): string {
  return formatApiError(err).message;
}
