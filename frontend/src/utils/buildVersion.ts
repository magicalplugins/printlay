/**
 * Detect when a new frontend build has been deployed while a user has the
 * app open in an existing tab.
 *
 * Vite emits hashed asset filenames (e.g. /assets/index-DRoQh5TA.js) on every
 * build. A user with a long-lived tab will keep the old index.html in memory,
 * so client-side navigation can try to fetch lazy chunks by old hashes that no
 * longer exist on the server -> 404 -> stuck loading state.
 *
 * The lazyWithRetry helper recovers from a single chunk 404 by reloading once.
 * That works but is reactive: the user already saw a broken page.
 *
 * This module is proactive: poll a cheap endpoint that returns the current
 * build hash, and when it changes, surface a banner so the user can refresh
 * on their terms (or auto-reload after a grace period).
 */

const POLL_VISIBLE_MS = 60_000;
const POLL_HIDDEN_MS = 0;
const FETCH_TIMEOUT_MS = 4_000;
const STORAGE_KEY = "printlay:build-hash";

export type BuildVersionState = {
  current: string | null;
  latest: string | null;
  outdated: boolean;
};

type Listener = (state: BuildVersionState) => void;

let state: BuildVersionState = {
  current: null,
  latest: null,
  outdated: false,
};
const listeners = new Set<Listener>();
let pollTimer: number | null = null;
let started = false;

function emit() {
  for (const fn of listeners) {
    try {
      fn(state);
    } catch {}
  }
}

async function fetchBuild(): Promise<string | null> {
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch("/api/build", {
      signal: ctrl.signal,
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
    });
    window.clearTimeout(t);
    if (!res.ok) return null;
    const data = (await res.json()) as { build?: string };
    return typeof data.build === "string" && data.build.length > 0
      ? data.build
      : null;
  } catch {
    return null;
  }
}

async function tick() {
  const latest = await fetchBuild();
  if (!latest) return;
  if (state.current === null) {
    state = { current: latest, latest, outdated: false };
    try {
      sessionStorage.setItem(STORAGE_KEY, latest);
    } catch {}
    emit();
    return;
  }
  if (latest !== state.current) {
    state = { ...state, latest, outdated: true };
    emit();
  } else if (state.latest !== latest) {
    state = { ...state, latest };
    emit();
  }
}

function schedule() {
  if (pollTimer !== null) {
    window.clearTimeout(pollTimer);
    pollTimer = null;
  }
  const interval =
    document.visibilityState === "visible" ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  if (interval <= 0) return; // pause when hidden
  pollTimer = window.setTimeout(async () => {
    await tick();
    schedule();
  }, interval);
}

function start() {
  if (started) return;
  started = true;
  // Don't hydrate from sessionStorage — always establish the current build
  // from the server on first tick. This avoids false "outdated" banners when
  // the user manually refreshes after a deploy.
  void tick().then(schedule);
  window.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void tick().then(schedule);
    } else {
      schedule();
    }
  });
  window.addEventListener("focus", () => {
    void tick();
  });
}

export function subscribeBuildVersion(fn: Listener): () => void {
  start();
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

export function reloadForLatest(): void {
  try {
    const url = new URL(window.location.href);
    url.searchParams.set("_v", String(Date.now()));
    window.location.replace(url.toString());
  } catch {
    window.location.reload();
  }
}
