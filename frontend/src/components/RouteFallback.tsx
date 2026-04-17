export function RouteFallback() {
  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="h-8 w-48 rounded-md bg-neutral-900 animate-pulse mb-4" />
        <div className="h-4 w-80 rounded-md bg-neutral-900 animate-pulse mb-10" />
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="h-32 rounded-xl border border-neutral-800 bg-neutral-900/50 animate-pulse"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
