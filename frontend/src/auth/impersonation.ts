/**
 * Module-level impersonation state.
 *
 * Readable from both React (via useImpersonation hook) and the API client
 * (direct import). Uses localStorage so refreshing the page doesn't kill
 * an active session. A setTimeout auto-clears when the grant expires.
 */

const STORAGE_KEY = "printlay_impersonation";

export interface Impersonation {
  userId: string;
  userEmail: string;
  grantId: string;
  expiresAt: string; // ISO 8601
}

type Listener = () => void;

let _current: Impersonation | null = null;
let _expireTimer: ReturnType<typeof setTimeout> | null = null;
const _listeners = new Set<Listener>();

function _load(): Impersonation | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Impersonation;
    if (new Date(parsed.expiresAt).getTime() <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function _notify() {
  for (const fn of _listeners) fn();
}

function _scheduleExpiry(imp: Impersonation) {
  if (_expireTimer) clearTimeout(_expireTimer);
  const ms = new Date(imp.expiresAt).getTime() - Date.now();
  if (ms <= 0) {
    endImpersonation();
    return;
  }
  _expireTimer = setTimeout(() => endImpersonation(), ms);
}

_current = _load();
if (_current) _scheduleExpiry(_current);

export function getImpersonation(): Impersonation | null {
  return _current;
}

export function startImpersonation(imp: Impersonation) {
  _current = imp;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(imp));
  _scheduleExpiry(imp);
  _notify();
}

export function endImpersonation() {
  if (_expireTimer) {
    clearTimeout(_expireTimer);
    _expireTimer = null;
  }
  const had = _current;
  _current = null;
  localStorage.removeItem(STORAGE_KEY);
  if (had) _notify();
}

export function subscribe(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
