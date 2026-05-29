import { SpotColour } from "../../api/spotColours";

/** Built-in spot presets, always offered even when the user's library is
 *  empty. Kept in sync with the backend `_BUILTIN_SPOTS` map so a name
 *  picked here resolves to the same Separation + RGB on output. */
export const SPOT_PRESETS = [
  { label: "CutContour", value: "CutContour", color: "#8B5CF6" },
  { label: "Score", value: "Score", color: "#0000FF" },
  { label: "Through-cut", value: "Through-cut", color: "#FF00FF" },
];

/** Resolve a spot value (name or `#hex`) to a swatch colour for preview. */
export function spotDisplayColor(value: string, spots: SpotColour[]): string {
  if (value.startsWith("#")) return value;
  const userSpot = spots.find((s) => s.name === value);
  if (userSpot) return userSpot.display_color;
  const preset = SPOT_PRESETS.find((p) => p.value === value);
  if (preset) return preset.color;
  return "#8B5CF6";
}

/**
 * One labelled spot-colour control: a colour picker (pick any → becomes a
 * custom `#hex`), a dropdown of named spot colours (presets + the user's
 * library), and a hex field shown when the value is custom.
 *
 * The `value` is either a spot **name** (e.g. `CutContour`, which a RIP
 * matches on as a Separation plate) or a `#RRGGBB` custom colour. Shared by
 * the Sheet Builder and the Jobs spot-colour panel so both behave identically.
 */
export default function SpotColourRow({
  label,
  value,
  spots,
  onChange,
}: {
  label: string;
  value: string;
  spots: SpotColour[];
  onChange: (v: string) => void;
}) {
  const isSpot = !value.startsWith("#");
  const displayColor = spotDisplayColor(value, spots);

  const allSpots = [
    ...SPOT_PRESETS.map((p) => ({ name: p.label, display_color: p.color })),
    ...spots
      .filter((s) => !SPOT_PRESETS.find((p) => p.value === s.name))
      .map((s) => ({ name: s.name, display_color: s.display_color })),
  ];

  return (
    <div>
      <label className="block text-xs text-neutral-400 mb-1">{label}</label>
      <div className="flex gap-2 items-center">
        <input
          type="color"
          value={displayColor}
          onChange={(e) => onChange(e.target.value)}
          className="w-7 h-7 shrink-0 rounded border border-neutral-600 bg-neutral-700 cursor-pointer p-0"
          title="Pick any colour (becomes custom)"
        />
        <select
          value={isSpot ? value : "__custom"}
          onChange={(e) => {
            if (e.target.value === "__custom") return;
            onChange(e.target.value);
          }}
          className="flex-1 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-sm text-white"
        >
          <optgroup label="Spot Colours">
            {allSpots.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
              </option>
            ))}
          </optgroup>
          <optgroup label="Custom">
            <option value="__custom">
              {isSpot ? "Custom colour..." : `Custom (${value})`}
            </option>
          </optgroup>
        </select>
        {isSpot && (
          <span className="text-[10px] text-neutral-500 font-mono w-20 truncate">
            {value}
          </span>
        )}
        {!isSpot && (
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-20 rounded bg-neutral-800 border border-neutral-700 px-2 py-1 text-[10px] text-white font-mono"
          />
        )}
      </div>
    </div>
  );
}
