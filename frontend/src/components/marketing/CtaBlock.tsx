import { Link } from "react-router-dom";

/** Conversion CTA reused at the foot of content pages. */
export default function CtaBlock({
  heading = "Stop dragging artwork at 2am.",
  sub = "Printlay turns your designs into print-ready gang sheets with cut lines — in four moves. Start free, no card required.",
}: {
  heading?: string;
  sub?: string;
}) {
  return (
    <section className="mt-16 rounded-2xl border border-violet-500/30 bg-gradient-to-br from-violet-500/10 via-fuchsia-500/5 to-transparent p-8 text-center">
      <h2 className="text-2xl font-bold tracking-tight text-white">{heading}</h2>
      <p className="mx-auto mt-2 max-w-xl text-sm text-neutral-400">{sub}</p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
        <Link
          to="/register"
          className="rounded-xl bg-white px-6 py-3 font-semibold text-neutral-950 transition hover:bg-neutral-200"
        >
          Start 7-day trial →
        </Link>
        <Link
          to="/pricing"
          className="rounded-xl border border-neutral-700 px-6 py-3 font-medium text-neutral-200 transition hover:border-neutral-500"
        >
          See pricing
        </Link>
      </div>
    </section>
  );
}
