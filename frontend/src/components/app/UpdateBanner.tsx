import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  BuildVersionState,
  reloadForLatest,
  subscribeBuildVersion,
} from "../../utils/buildVersion";

/**
 * Surfaces a small, dismissable banner when a new frontend build has been
 * deployed while the tab was open. Also opportunistically forces a hard
 * reload on the user's NEXT in-app route change after we detect the new
 * build, so stale lazy chunks never get a chance to 404. The route-change
 * reload feels seamless (user navigates -> page loads fresh code) instead of
 * a surprise full-page refresh.
 */
export default function UpdateBanner() {
  const [state, setState] = useState<BuildVersionState>({
    current: null,
    latest: null,
    outdated: false,
  });
  const [dismissed, setDismissed] = useState(false);
  const location = useLocation();
  const firstPathRef = useRef<string | null>(null);

  useEffect(() => subscribeBuildVersion(setState), []);

  useEffect(() => {
    if (firstPathRef.current === null) {
      firstPathRef.current = location.pathname;
      return;
    }
    if (firstPathRef.current === location.pathname) return;
    firstPathRef.current = location.pathname;
    if (state.outdated) {
      // Navigating away anyway -- swap in fresh code transparently.
      reloadForLatest();
    }
  }, [location.pathname, state.outdated]);

  if (!state.outdated || dismissed) return null;

  return (
    <div className="bg-indigo-600/95 border-b border-indigo-400/40 text-white text-sm">
      <div className="max-w-7xl mx-auto px-3 sm:px-6 py-2 flex items-center gap-3">
        <span className="font-medium">A new version of PrintLay is ready.</span>
        <span className="hidden sm:inline text-indigo-100">
          Refresh to avoid loading issues.
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={reloadForLatest}
            className="rounded-md bg-white text-indigo-700 hover:bg-indigo-50 font-semibold px-3 py-1.5 text-xs"
          >
            Refresh now
          </button>
          <button
            type="button"
            onClick={() => setDismissed(true)}
            className="rounded-md border border-white/40 text-white/90 hover:bg-white/10 px-2 py-1.5 text-xs"
            aria-label="Dismiss"
          >
            Later
          </button>
        </div>
      </div>
    </div>
  );
}
