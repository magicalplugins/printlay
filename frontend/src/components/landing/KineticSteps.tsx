import { motion, useInView } from "framer-motion";
import { useRef } from "react";

const STEPS = [
  {
    n: "01",
    word: "Create",
    sub: "template",
    body: "Upload your AI/PDF, or generate a grid in-app — artboard, shape, gap. Auto-fits, dead-centred.",
    accent: "from-fuchsia-500 to-rose-500",
  },
  {
    n: "02",
    word: "Choose",
    sub: "the order",
    body: "Click slots one by one, or sweep a row left-to-right and number a whole strip at once.",
    accent: "from-amber-400 to-orange-500",
  },
  {
    n: "03",
    word: "Fill",
    sub: "from catalogue",
    body: "Pick an artwork, type a quantity, watch it drop into the next slots in your order.",
    accent: "from-emerald-400 to-teal-500",
  },
  {
    n: "04",
    word: "Export",
    sub: "print-ready PDF",
    body: "Artboard preserved exact. Slot rectangles hidden. Drop straight into VersaWorks.",
    accent: "from-sky-400 to-indigo-500",
  },
];

export default function KineticSteps() {
  return (
    <section className="relative px-6 py-32 border-t border-neutral-900">
      <div className="max-w-6xl mx-auto">
        <div className="text-center space-y-3 mb-20">
          <div className="text-xs uppercase tracking-widest text-neutral-500">
            How it works
          </div>
          <h2 className="text-4xl md:text-6xl font-bold tracking-tight">
            Four moves. That's the whole product.
          </h2>
        </div>

        <div className="space-y-24 md:space-y-32">
          {STEPS.map((s, i) => (
            <Step key={s.n} step={s} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function Step({
  step,
  index,
}: {
  step: (typeof STEPS)[number];
  index: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4, once: true });
  const flip = index % 2 === 1;

  return (
    <div
      ref={ref}
      className={`grid md:grid-cols-2 gap-10 md:gap-16 items-center ${
        flip ? "md:[&>:first-child]:order-2" : ""
      }`}
    >
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={inView ? { opacity: 1, y: 0 } : {}}
        transition={{ duration: 0.6, ease: [0.21, 0.47, 0.32, 0.98] }}
        className="space-y-5"
      >
        <div
          className={`inline-block text-xs font-mono tracking-widest text-transparent bg-clip-text bg-gradient-to-r ${step.accent}`}
        >
          STEP {step.n}
        </div>
        <h3 className="text-5xl md:text-7xl font-bold leading-[0.9] tracking-tight">
          {step.word}{" "}
          <span className="block italic font-light text-neutral-400">
            {step.sub}.
          </span>
        </h3>
        <p className="text-lg text-neutral-400 max-w-md">{step.body}</p>
      </motion.div>

      <motion.div
        initial={{ opacity: 0, scale: 0.96 }}
        animate={inView ? { opacity: 1, scale: 1 } : {}}
        transition={{ duration: 0.7, delay: 0.1 }}
        className="relative aspect-[4/3] rounded-2xl overflow-hidden border border-neutral-800 bg-neutral-900"
      >
        <div
          className={`absolute inset-0 opacity-30 bg-gradient-to-br ${step.accent}`}
        />
        <StepIllustration index={index} />
        <div className="absolute bottom-3 right-3 text-[10px] uppercase tracking-widest text-neutral-500">
          demo clip drops here
        </div>
      </motion.div>
    </div>
  );
}

function StepIllustration({ index }: { index: number }) {
  if (index === 0) return <TemplateIllustration />;
  if (index === 1) return <OrderIllustration />;
  if (index === 2) return <FillIllustration />;
  return <ExportIllustration />;
}

function TemplateIllustration() {
  const cells = Array.from({ length: 24 });
  return (
    <svg viewBox="0 0 400 300" className="absolute inset-0 w-full h-full">
      {cells.map((_, i) => {
        const col = i % 6;
        const row = Math.floor(i / 6);
        return (
          <motion.rect
            key={i}
            x={30 + col * 58}
            y={30 + row * 58}
            width="48"
            height="48"
            rx="6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-white/40"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: 1 }}
            transition={{ duration: 0.6, delay: i * 0.03 }}
          />
        );
      })}
    </svg>
  );
}

function OrderIllustration() {
  const cells = Array.from({ length: 24 });
  return (
    <svg viewBox="0 0 400 300" className="absolute inset-0 w-full h-full">
      {cells.map((_, i) => {
        const col = i % 6;
        const row = Math.floor(i / 6);
        return (
          <g key={i}>
            <rect
              x={30 + col * 58}
              y={30 + row * 58}
              width="48"
              height="48"
              rx="6"
              fill="rgba(255,255,255,0.08)"
              stroke="rgba(255,255,255,0.25)"
              strokeWidth="1"
            />
            <motion.text
              x={30 + col * 58 + 24}
              y={30 + row * 58 + 30}
              textAnchor="middle"
              fontFamily="monospace"
              fontSize="14"
              fill="currentColor"
              className="text-white"
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.3, delay: i * 0.05 }}
            >
              {i + 1}
            </motion.text>
          </g>
        );
      })}
    </svg>
  );
}

function FillIllustration() {
  const cells = Array.from({ length: 24 });
  return (
    <svg viewBox="0 0 400 300" className="absolute inset-0 w-full h-full">
      {cells.map((_, i) => {
        const col = i % 6;
        const row = Math.floor(i / 6);
        const filled = i < 18;
        return (
          <motion.rect
            key={i}
            x={30 + col * 58}
            y={30 + row * 58}
            width="48"
            height="48"
            rx="6"
            fill={
              filled
                ? `hsl(${(i * 30) % 360}, 70%, 60%)`
                : "rgba(255,255,255,0.05)"
            }
            stroke="rgba(255,255,255,0.2)"
            strokeWidth="1"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.3, delay: i * 0.04 }}
          />
        );
      })}
    </svg>
  );
}

function ExportIllustration() {
  return (
    <svg viewBox="0 0 400 300" className="absolute inset-0 w-full h-full">
      <motion.rect
        x="60"
        y="40"
        width="280"
        height="220"
        rx="10"
        fill="rgba(255,255,255,0.92)"
        stroke="rgba(255,255,255,0.4)"
        strokeWidth="2"
        initial={{ y: 60, opacity: 0 }}
        animate={{ y: 40, opacity: 1 }}
        transition={{ duration: 0.6 }}
      />
      <motion.text
        x="200"
        y="160"
        textAnchor="middle"
        fontFamily="monospace"
        fontSize="22"
        fill="#0a0a0a"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
      >
        sheet-001.pdf
      </motion.text>
      <motion.text
        x="200"
        y="190"
        textAnchor="middle"
        fontFamily="monospace"
        fontSize="11"
        fill="#737373"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        420 × 297 mm — print-ready
      </motion.text>
    </svg>
  );
}
