export type FilterPreset = {
  id: string;
  label: string;
  /** CSS `filter` value, mirrors the Pillow operation backend-side. */
  css: string;
};

/** Curated 12 - "Original" plus 11 of the most common social-media looks.
 *  The CSS values here are intentionally close (but not identical) to
 *  the Pillow recipes in `backend/services/image_filters.py`. Perfect
 *  parity isn't possible across the two engines; the goal is "the
 *  preview looks recognisably the same as the printed result". */
export const FILTER_PRESETS: FilterPreset[] = [
  { id: "none", label: "Original", css: "none" },
  { id: "bw", label: "B&W", css: "grayscale(1)" },
  { id: "sepia", label: "Sepia", css: "sepia(0.85)" },
  { id: "vintage", label: "Vintage", css: "sepia(0.35) saturate(0.7) contrast(0.85)" },
  { id: "faded", label: "Faded", css: "saturate(0.6) contrast(0.78) brightness(1.08)" },
  { id: "vivid", label: "Vivid", css: "saturate(1.5) contrast(1.15)" },
  { id: "noir", label: "Noir", css: "grayscale(1) contrast(1.4)" },
  { id: "cool", label: "Cool", css: "hue-rotate(-12deg) saturate(1.05) brightness(1.02)" },
  { id: "warm", label: "Warm", css: "hue-rotate(8deg) saturate(1.1) brightness(1.02)" },
  { id: "clarendon", label: "Clarendon", css: "contrast(1.2) saturate(1.35)" },
  { id: "aden", label: "Aden", css: "saturate(0.85) brightness(1.1) hue-rotate(-15deg)" },
  { id: "moon", label: "Moon", css: "grayscale(1) brightness(1.1) contrast(1.15)" },
  { id: "invert", label: "Invert", css: "invert(1)" },
];

export function filterCss(id: string | undefined | null): string {
  const preset = FILTER_PRESETS.find((f) => f.id === (id || "none"));
  return preset?.css || "none";
}
