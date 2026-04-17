import { motion, useInView } from "framer-motion";
import { useEffect, useRef, useState } from "react";

const DEFAULT_CLIP_URL =
  import.meta.env.VITE_DEMO_CLIP_URL ?? "";

export default function DemoClip() {
  const ref = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const inView = useInView(ref, { amount: 0.3, once: true });
  const [hasClip, setHasClip] = useState(Boolean(DEFAULT_CLIP_URL));

  useEffect(() => {
    if (inView && hasClip) videoRef.current?.play().catch(() => {});
  }, [inView, hasClip]);

  return (
    <section ref={ref} className="px-6 py-32 border-t border-neutral-900">
      <div className="max-w-5xl mx-auto space-y-10">
        <div className="text-center space-y-3">
          <div className="text-xs uppercase tracking-widest text-neutral-500">
            See it move
          </div>
          <h2 className="text-4xl md:text-5xl font-bold tracking-tight">
            One sheet, fifteen seconds.
          </h2>
        </div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={inView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.7 }}
          className="relative aspect-video rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900"
        >
          {hasClip ? (
            <video
              ref={videoRef}
              src={DEFAULT_CLIP_URL}
              muted
              loop
              playsInline
              autoPlay
              onError={() => setHasClip(false)}
              className="w-full h-full object-cover"
            />
          ) : (
            <ClipPlaceholder />
          )}
        </motion.div>

        <p className="text-center text-sm text-neutral-500">
          Drop a screen-capture MP4 in R2 under <code className="text-neutral-400">marketing/clips/</code>{" "}
          and set <code className="text-neutral-400">VITE_DEMO_CLIP_URL</code> at build time, or
          serve it via the public R2 base URL.
        </p>
      </div>
    </section>
  );
}

function ClipPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <div className="absolute inset-0 bg-gradient-to-br from-fuchsia-700/30 via-transparent to-indigo-700/30" />
      <div className="relative text-center space-y-3">
        <div className="text-6xl">▶</div>
        <div className="text-neutral-400 text-sm uppercase tracking-widest">
          Demo clip — placeholder
        </div>
      </div>
    </div>
  );
}
