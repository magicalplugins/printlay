import { ComponentType, lazy } from "react";

const RELOAD_KEY = "printlay:chunk-reload-attempted";
// Flag is auto-cleared after this many ms so a stuck "1" can't permanently
// disable the auto-reload escape hatch.
const RELOAD_FLAG_TTL_MS = 30_000;

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg)
  );
}

function readReloadFlag(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    if (!Number.isFinite(ts)) return false;
    if (Date.now() - ts > RELOAD_FLAG_TTL_MS) {
      sessionStorage.removeItem(RELOAD_KEY);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function setReloadFlag(): void {
  try {
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {}
}

function clearReloadFlag(): void {
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {}
}

function forceReload(): void {
  // Force a network fetch of index.html (bypasses heuristic HTTP cache) by
  // appending a cache-busting query param and using location.replace so the
  // broken state is not added to history. The server also sends Cache-Control:
  // no-cache for index.html, but this is belt-and-braces for proxies/CDNs.
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_r", String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}

/**
 * Drop-in replacement for React.lazy that auto-recovers from stale chunk
 * references after a deploy. When the dynamic import fails with a
 * chunk-load error and we haven't already tried in the last 30s, we force a
 * one-shot full-page reload to fetch the new bundle. The TTL'd
 * sessionStorage guard prevents reload loops while still letting users
 * recover automatically on the next genuine deploy.
 */
export function lazyWithRetry<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const mod = await factory();
      clearReloadFlag();
      return mod;
    } catch (err) {
      if (isChunkLoadError(err)) {
        if (!readReloadFlag()) {
          setReloadFlag();
          forceReload();
          // Hang forever; the page is about to be replaced.
          return new Promise<{ default: T }>(() => {});
        }
      }
      throw err;
    }
  });
}
