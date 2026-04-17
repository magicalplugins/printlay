import { motion } from "framer-motion";
import { Link } from "react-router-dom";

export default function Hero() {
  return (
    <section className="relative min-h-[92vh] flex items-center justify-center overflow-hidden px-6 pt-20 pb-32">
      <div className="absolute inset-0 -z-10">
        <div className="absolute -top-40 -left-40 h-[40rem] w-[40rem] rounded-full bg-fuchsia-700/20 blur-3xl" />
        <div className="absolute top-1/2 -right-40 h-[40rem] w-[40rem] rounded-full bg-indigo-600/20 blur-3xl" />
        <div className="absolute bottom-0 left-1/3 h-[30rem] w-[30rem] rounded-full bg-emerald-500/10 blur-3xl" />
        <Grid />
      </div>

      <div className="max-w-5xl text-center space-y-10">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
          className="inline-flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/60 px-4 py-1.5 text-xs uppercase tracking-widest text-neutral-300"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          Beta — free during build
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05 }}
          className="text-[clamp(2.75rem,8vw,7rem)] font-bold leading-[0.95] tracking-tight"
        >
          Print-ready
          <br />
          in <span className="italic font-light">four moves.</span>
        </motion.h1>

        <motion.p
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="text-lg md:text-xl text-neutral-400 max-w-2xl mx-auto"
        >
          For print shops who gang up sheets. Upload a template, program the slot
          order, fill from your catalogue, export. No more dragging in
          Illustrator at 2am.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          className="flex items-center justify-center gap-3"
        >
          <Link
            to="/register"
            className="rounded-xl bg-white px-6 py-3.5 font-semibold text-neutral-950 hover:bg-neutral-200 transition"
          >
            Start free →
          </Link>
          <Link
            to="/login"
            className="rounded-xl border border-neutral-700 px-6 py-3.5 font-medium text-neutral-200 hover:border-neutral-500 transition"
          >
            Log in
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

function Grid() {
  return (
    <svg
      className="absolute inset-0 h-full w-full opacity-[0.06]"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
          <path d="M 48 0 L 0 0 0 48" fill="none" stroke="currentColor" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#grid)" />
    </svg>
  );
}
