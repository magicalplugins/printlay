import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  // iOS Safari's "first-tap shows hover, second-tap clicks" behaviour
  // makes every hover-styled button feel laggy on touch. With this
  // enabled, Tailwind only emits `hover:` styles inside an
  // `@media (hover: hover)` block, so touch devices skip the sticky
  // hover state and the very first tap fires the click handler.
  future: {
    hoverOnlyWhenSupported: true,
  },
  theme: {
    extend: {
      fontFamily: {
        display: ['"Inter"', "system-ui", "sans-serif"],
      },
    },
  },
  plugins: [],
} satisfies Config;
