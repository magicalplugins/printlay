/**
 * "Time saved vs manual imposition" — pure math + display helpers.
 *
 * The whole feature is opinionated about being *honest*: the user's
 * per-unit values (setup minutes, per-slot seconds) come from their
 * own preferences, the only inputs we add are real counts (slots
 * filled, jobs generated). No fudge multipliers, no marketing
 * inflation. The formula is auditable in Settings.
 *
 *     minutes_saved = setup_minutes + (slots_filled × per_slot_seconds / 60)
 *
 * Intent: a defensible estimate that a print-shop owner who used to do
 * this in InDesign by hand recognises as roughly true. Defaults
 * (10 min setup + 40 s per slot) match a typical manual workflow but
 * are user-editable so anyone faster or slower can tune them.
 */

export type TimeSavedPrefs = {
  setupMinutes: number;
  perSlotSeconds: number;
};

/**
 * Default per-unit values. Used when the user hasn't been hydrated
 * yet (initial render before /me resolves) so the UI doesn't flash a
 * "0 min saved" placeholder. Match the backend defaults exactly so
 * the rendered estimate doesn't shift once /me lands.
 */
export const TIME_SAVED_DEFAULTS: TimeSavedPrefs = {
  setupMinutes: 10,
  perSlotSeconds: 40,
};

/**
 * Estimated minutes a single output saved vs doing the same imposition
 * manually in InDesign / Illustrator (open artboard, set bleed/safe
 * margins, configure cut marks, place each slot's artwork, scale,
 * rotate, align, verify, export PDF/X).
 *
 * Always returns a non-negative number rounded to one decimal so
 * callers can format it however they like without worrying about
 * floating-point drift.
 */
export function minutesSavedForOutput(
  slotsFilled: number,
  prefs: TimeSavedPrefs = TIME_SAVED_DEFAULTS
): number {
  const setup = Math.max(0, prefs.setupMinutes || 0);
  const perSlot = Math.max(0, prefs.perSlotSeconds || 0);
  const slots = Math.max(0, Math.floor(slotsFilled || 0));
  const minutes = setup + (slots * perSlot) / 60;
  return Math.round(minutes * 10) / 10;
}

/**
 * Sum the time saved across a set of outputs. Filter the input list
 * to "this month" / "this week" / "lifetime" yourself before passing
 * in - keeping this function dumb makes it easy to compose.
 */
export function totalMinutesSaved<T extends { slots_filled: number }>(
  outputs: readonly T[],
  prefs: TimeSavedPrefs = TIME_SAVED_DEFAULTS
): number {
  let total = 0;
  for (const o of outputs) total += minutesSavedForOutput(o.slots_filled, prefs);
  return Math.round(total * 10) / 10;
}

/**
 * Format a minutes count for display. Shapes:
 *   - 0           → "0 min"
 *   - 0.4         → "<1 min"
 *   - 1..89       → "12 min"
 *   - 90..(<24h)  → "1 h 30 min"  (drops the minutes when zero: "2 h")
 *   - 24h+        → "1 d 4 h"     (drops the hours when zero: "3 d")
 *
 * Days threshold is intentional: "47 hours saved this month" reads
 * as braggy noise; "1 d 23 h" tells the same story while reminding
 * the user that we're talking real wall-clock time, not made-up
 * "productivity hours". The day boundary is a 24-hour day, not an
 * 8-hour workday - we're not pretending to count working hours.
 */
export function humanizeMinutes(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "0 min";
  if (minutes < 1) return "<1 min";
  if (minutes < 90) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 24) {
    const h = Math.floor(minutes / 60);
    const m = Math.round(minutes - h * 60);
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const d = Math.floor(minutes / (60 * 24));
  const h = Math.round((minutes - d * 60 * 24) / 60);
  return h === 0 ? `${d} d` : `${d} d ${h} h`;
}
