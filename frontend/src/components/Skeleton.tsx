export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-5 space-y-3"
        >
          <div className="h-4 w-32 rounded bg-neutral-800 animate-pulse" />
          <div className="h-3 w-24 rounded bg-neutral-800/70 animate-pulse" />
          <div className="flex gap-2 pt-2">
            <div className="h-7 w-16 rounded bg-neutral-800 animate-pulse" />
            <div className="h-7 w-24 rounded bg-neutral-800 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ThumbnailGridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-3">
      {Array.from({ length: count }).map((_, i) => (
        <div
          key={i}
          className="aspect-square rounded-lg border border-neutral-800 bg-neutral-900 animate-pulse"
        />
      ))}
    </div>
  );
}
