import { useState } from "react";
import {
  rgbCss,
  rgbToHex,
  type ColorSwap,
  type RGB,
} from "../../api/colorProfiles";
import RgbColorPicker from "./RgbColorPicker";

type Props = {
  swaps: ColorSwap[];
  onChange: (next: ColorSwap[]) => void;
  /** Optional list of source colours detected from the user's job assets,
   *  used to power the "+ Add from detected" picker. */
  detected?: RGB[];
  /** Compact mode hides the "+ Add from detected" toolbar - used inside
   *  modals where the detected list isn't relevant. */
  compact?: boolean;
};

/**
 * Editable list of colour swaps. Each row shows a source swatch (clickable
 * to edit), an arrow, and a target swatch (clickable to edit), plus an
 * optional label and remove button.
 *
 * Used in two places:
 *   1. Settings -> Color profiles (editing a saved profile in place)
 *   2. JobFiller -> Colors panel (editing the per-job draft)
 */
export default function ColorProfileEditor({
  swaps,
  onChange,
  detected,
  compact,
}: Props) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  const [openSide, setOpenSide] = useState<"source" | "target">("target");

  function update(idx: number, patch: Partial<ColorSwap>) {
    onChange(
      swaps.map((s, i) => (i === idx ? { ...s, ...patch } : s))
    );
  }

  function remove(idx: number) {
    onChange(swaps.filter((_, i) => i !== idx));
    if (openIdx === idx) setOpenIdx(null);
  }

  function add(source?: RGB) {
    const seed: RGB = source ?? [0, 0, 0];
    const next: ColorSwap = { source: seed, target: seed };
    onChange([...swaps, next]);
    setOpenIdx(swaps.length);
    setOpenSide("target");
  }

  const detectedRemaining = (detected ?? []).filter(
    (d) => !swaps.some((s) => s.source[0] === d[0] && s.source[1] === d[1] && s.source[2] === d[2])
  );

  return (
    <div className="space-y-2">
      {!compact && detectedRemaining.length > 0 && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 space-y-2">
          <div className="text-xs font-semibold text-violet-300">
            Detected in this job ({detectedRemaining.length} unused)
          </div>
          <div className="flex flex-wrap gap-2">
            {detectedRemaining.map((rgb) => (
              <button
                key={rgb.join(",")}
                type="button"
                onClick={() => add(rgb)}
                className="flex items-center gap-1.5 rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs hover:border-violet-500 transition"
                title={`Add swap from ${rgbToHex(rgb)}`}
              >
                <span
                  className="h-4 w-4 rounded border border-black/20"
                  style={{ backgroundColor: rgbCss(rgb) }}
                />
                <span className="font-mono text-neutral-300">{rgbToHex(rgb)}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {swaps.length === 0 ? (
        <div className="rounded-lg border border-dashed border-neutral-800 p-6 text-center text-sm text-neutral-500">
          No draft swaps. Click a detected colour above, or add one manually
          below. Anything you add lives on this job until you save it as a
          profile.
        </div>
      ) : (
        <ul className="space-y-2">
          {swaps.map((s, idx) => {
            const isOpen = openIdx === idx;
            return (
              <li
                key={idx}
                className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 space-y-2"
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setOpenIdx(isOpen && openSide === "source" ? null : idx);
                      setOpenSide("source");
                    }}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition ${
                      isOpen && openSide === "source"
                        ? "border-violet-500"
                        : "border-neutral-700 hover:border-neutral-500"
                    }`}
                    title={`Source ${rgbToHex(s.source)}`}
                  >
                    <span
                      className="h-6 w-6 rounded border border-black/20"
                      style={{ backgroundColor: rgbCss(s.source) }}
                    />
                    <span className="text-xs font-mono text-neutral-300">
                      {rgbToHex(s.source)}
                    </span>
                  </button>

                  <span className="text-neutral-500">→</span>

                  <button
                    type="button"
                    onClick={() => {
                      setOpenIdx(isOpen && openSide === "target" ? null : idx);
                      setOpenSide("target");
                    }}
                    className={`flex items-center gap-2 rounded-md border px-2 py-1.5 transition ${
                      isOpen && openSide === "target"
                        ? "border-violet-500"
                        : "border-neutral-700 hover:border-neutral-500"
                    }`}
                    title={`Target ${rgbToHex(s.target)}`}
                  >
                    <span
                      className="h-6 w-6 rounded border border-black/20"
                      style={{ backgroundColor: rgbCss(s.target) }}
                    />
                    <span className="text-xs font-mono text-neutral-300">
                      {rgbToHex(s.target)}
                    </span>
                  </button>

                  <input
                    type="text"
                    value={s.label ?? ""}
                    onChange={(e) => update(idx, { label: e.target.value })}
                    placeholder="Label (optional)"
                    className="flex-1 min-w-0 bg-transparent text-sm text-neutral-300 placeholder-neutral-600 outline-none border-b border-transparent focus:border-neutral-700"
                    maxLength={80}
                  />

                  <button
                    type="button"
                    onClick={() => remove(idx)}
                    className="text-neutral-500 hover:text-rose-400 text-xs px-2 py-1"
                    title="Remove swap"
                  >
                    ✕
                  </button>
                </div>

                {isOpen && (
                  <RgbColorPicker
                    value={openSide === "source" ? s.source : s.target}
                    onChange={(rgb) =>
                      update(idx, openSide === "source" ? { source: rgb } : { target: rgb })
                    }
                    source={openSide === "target" ? s.source : undefined}
                    label={openSide === "source" ? "Source colour (matched in artwork)" : "Target colour (printed)"}
                    detectedForSnap={
                      openSide === "source" ? detected : undefined
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}

      <button
        type="button"
        onClick={() => add()}
        className="w-full rounded-lg border border-dashed border-neutral-700 px-3 py-2 text-sm text-neutral-400 hover:border-violet-500 hover:text-violet-300 transition"
      >
        + Add swap manually
      </button>
    </div>
  );
}
