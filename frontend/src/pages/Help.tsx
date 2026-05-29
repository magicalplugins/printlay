import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api/client";

/* ─────────────────────────────────────────────────────────────────────
   Help Centre — Getting Started, FAQ, and What's New.
   ───────────────────────────────────────────────────────────────────── */

type ChangelogEntry = {
  id: string;
  title: string;
  body: string;
  tag: string;
  published_at: string;
};

const FAQ: { q: string; a: string }[] = [
  {
    q: "How do I prepare my template in Illustrator or Affinity?",
    a: "Create your artboard at the exact sheet size you'll print on. Place rectangles, circles, or any closed shapes where your artwork slots should go. Put those shapes on a layer named POSITIONS (or JIG, SLOTS, DIELINE, CUT). Export as PDF with layers preserved. In Illustrator use 'Save As PDF'. In Affinity, use plain PDF or PDF/X-4 (not 'PDF for print' as it strips layers).",
  },
  {
    q: "My slot rectangles are showing in the exported PDF — what's wrong?",
    a: "This usually means the layer containing your slot shapes wasn't detected. Make sure the layer is named POSITIONS, JIG, SLOTS, or DIELINE (case doesn't matter). If you exported from Affinity, use plain PDF or PDF/X-4 instead of 'PDF for print'. You may need to re-upload the template after fixing.",
  },
  {
    q: "What file formats can I upload as artwork?",
    a: "Artwork can be PDF, JPEG, PNG, or TIFF. For best quality, use PDF or high-resolution images (300 DPI or above at final print size).",
  },
  {
    q: "How do cut lines work?",
    a: "When exporting a job, tick 'Include cut lines' and choose your spot colour (e.g. CutContour for Roland VersaWorks). Printlay draws a separate vector path on its own layer using a PDF Separation colorspace — your RIP reads this as the knife path. The cut lines are independent of your POSITIONS layer.",
  },
  {
    q: "Can I change the colour of the white border on stickers?",
    a: "Yes — the white border extends 3mm past the cut line specifically so you can swap it for any solid colour later without the cut eating into your artwork.",
  },
  {
    q: "How do I cancel or change my subscription?",
    a: "Go to Settings → Billing. You can upgrade, downgrade, or cancel at any time. If you cancel, your account stays accessible (read-only) until the billing period ends. Your templates and artwork are never deleted.",
  },
  {
    q: "What happens when my trial ends?",
    a: "Your data stays exactly where it is. You just can't create new jobs or export until you pick a plan. There's no rush — everything is safe.",
  },
  {
    q: "I need help with something else",
    a: "Use the chat widget in the bottom-right corner of any page. We typically respond within a few hours during UK business hours.",
  },
];

const STEPS = [
  {
    num: "1",
    title: "Upload a template",
    desc: "Drop in your Illustrator/Affinity PDF with slot shapes on a POSITIONS layer.",
    link: "/app/templates/new",
    cta: "Upload template →",
  },
  {
    num: "2",
    title: "Create a job",
    desc: "Pick a template and tell Printlay how many copies you need.",
    link: "/app/jobs/new",
    cta: "New job →",
  },
  {
    num: "3",
    title: "Fill your slots",
    desc: "Upload artwork or pick from your catalogue. Drag to reorder, preview live.",
    link: null,
    cta: null,
  },
  {
    num: "4",
    title: "Export print-ready PDF",
    desc: "One click — artwork placed, cut lines added, POSITIONS layer hidden. Send straight to your RIP.",
    link: null,
    cta: null,
  },
];

export default function Help() {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[]>([]);

  useEffect(() => {
    api<{ items: ChangelogEntry[] }>("/api/changelog")
      .then((r) => setChangelog(r.items))
      .catch(() => {});
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-12">
      {/* Header */}
      <header>
        <h1 className="text-3xl font-bold tracking-tight">Help Centre</h1>
        <p className="text-neutral-500 text-sm mt-1">
          Everything you need to get print-ready in four moves.
        </p>
      </header>

      {/* Getting Started */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Getting started</h2>

        {/* Video tutorial */}
        <div className="rounded-xl border border-neutral-800 overflow-hidden aspect-video">
          <iframe
            src="https://player.vimeo.com/video/1195987342?h=&title=0&byline=0&portrait=0"
            className="w-full h-full"
            allow="autoplay; fullscreen; picture-in-picture"
            allowFullScreen
            title="Printlay — Getting Started"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {STEPS.map((s) => (
            <div
              key={s.num}
              className="relative rounded-xl border border-neutral-800 bg-neutral-950/60 p-4 space-y-2"
            >
              <div className="w-8 h-8 rounded-full bg-violet-500/15 border border-violet-500/30 flex items-center justify-center text-sm font-bold text-violet-300">
                {s.num}
              </div>
              <h3 className="text-sm font-semibold text-neutral-100">
                {s.title}
              </h3>
              <p className="text-xs text-neutral-400 leading-relaxed">
                {s.desc}
              </p>
              {s.link && (
                <Link
                  to={s.link}
                  className="inline-block text-xs font-medium text-violet-300 hover:text-violet-200 mt-1"
                >
                  {s.cta}
                </Link>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Frequently asked questions</h2>
        <div className="rounded-xl border border-neutral-800 divide-y divide-neutral-800 overflow-hidden">
          {FAQ.map((item, i) => (
            <div key={i}>
              <button
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
                className="w-full text-left px-5 py-4 flex items-center justify-between gap-4 hover:bg-neutral-900/40 transition"
              >
                <span className="text-sm font-medium text-neutral-200">
                  {item.q}
                </span>
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  className={`shrink-0 text-neutral-500 transition-transform duration-200 ${
                    openFaq === i ? "rotate-180" : ""
                  }`}
                >
                  <path
                    d="M4 6l4 4 4-4"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {openFaq === i && (
                <div className="px-5 pb-4 text-sm text-neutral-400 leading-relaxed">
                  {item.a}
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* What's New */}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What's new</h2>
        {changelog.length === 0 ? (
          <div className="rounded-xl border border-neutral-800 p-6 text-center text-sm text-neutral-500">
            No updates yet — check back soon.
          </div>
        ) : (
          <div className="space-y-3">
            {changelog.map((entry) => (
              <article
                key={entry.id}
                className="rounded-xl border border-neutral-800 bg-neutral-950/60 p-4 space-y-1.5"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <TagBadge tag={entry.tag} />
                  <span className="text-[11px] text-neutral-500">
                    {new Date(entry.published_at).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                      year: "numeric",
                    })}
                  </span>
                </div>
                <h3 className="text-sm font-semibold text-neutral-100">
                  {entry.title}
                </h3>
                <p className="text-xs text-neutral-400 leading-relaxed whitespace-pre-wrap">
                  {entry.body}
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* Contact nudge */}
      <section className="rounded-xl border border-neutral-800 bg-gradient-to-br from-violet-500/[0.04] to-fuchsia-500/[0.02] p-6 text-center space-y-2">
        <p className="text-sm text-neutral-300">
          Can't find what you're looking for?
        </p>
        <p className="text-xs text-neutral-500">
          Use the chat widget in the bottom-right corner — we're usually
          around during UK business hours.
        </p>
      </section>
    </div>
  );
}

function TagBadge({ tag }: { tag: string }) {
  const styles: Record<string, string> = {
    feature: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30",
    improvement: "bg-blue-500/15 text-blue-300 border-blue-500/30",
    fix: "bg-amber-500/15 text-amber-300 border-amber-500/30",
  };
  const cls = styles[tag] ?? "bg-neutral-500/15 text-neutral-300 border-neutral-500/30";
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 text-[10px] uppercase tracking-widest rounded-full border ${cls}`}
    >
      {tag}
    </span>
  );
}
