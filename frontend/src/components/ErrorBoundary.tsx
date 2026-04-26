import { Component, ErrorInfo, ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

const RELOAD_KEY = "printlay:chunk-reload-attempted";

function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /Loading chunk \d+ failed/i.test(msg) ||
    /ChunkLoadError/i.test(msg)
  );
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Printlay UI crashed:", error, info);
    // Stale-bundle recovery: if a code-split chunk failed to load (typically
    // because we just redeployed and the old hashed filename no longer
    // exists), reload once to fetch the new bundle.
    if (isChunkLoadError(error)) {
      let alreadyTried = false;
      try {
        alreadyTried = sessionStorage.getItem(RELOAD_KEY) === "1";
      } catch {}
      if (!alreadyTried) {
        try {
          sessionStorage.setItem(RELOAD_KEY, "1");
        } catch {}
        window.location.reload();
      }
    }
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="min-h-screen bg-neutral-950 text-neutral-100 flex items-center justify-center p-6">
        <div className="max-w-lg w-full rounded-2xl border border-neutral-800 bg-neutral-900/50 p-8 text-center">
          <div className="text-5xl mb-4">⚠</div>
          <h1 className="text-2xl font-bold mb-2">Something broke.</h1>
          <p className="text-neutral-400 text-sm mb-6">
            The Printlay UI threw an unexpected error. The details are in the
            browser console; you can usually recover by reloading.
          </p>
          <pre className="text-left text-xs text-rose-300 bg-black/40 rounded-lg p-3 mb-6 overflow-auto max-h-48">
            {error.message}
          </pre>
          <div className="flex gap-2 justify-center">
            <button
              onClick={this.reset}
              className="rounded-lg border border-neutral-700 px-5 py-2.5 text-sm hover:border-neutral-500"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="rounded-lg bg-white px-5 py-2.5 text-sm font-semibold text-neutral-950 hover:bg-neutral-200"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
