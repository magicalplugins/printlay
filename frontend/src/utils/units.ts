/**
 * Size unit helpers for the sticker widget + admin.
 *
 * All sizes are STORED in millimetres on the backend. These helpers only
 * convert for display/entry so merchants and customers can work in cm (the
 * default) or mm.
 */
export type SizeUnit = "cm" | "mm";

export function mmToUnit(mm: number, unit: SizeUnit): number {
  return unit === "cm" ? mm / 10 : mm;
}

export function unitToMm(value: number, unit: SizeUnit): number {
  return unit === "cm" ? value * 10 : value;
}

/** Format a length (given in mm) as a bare number string in the chosen unit. */
export function fmtLenNum(mm: number, unit: SizeUnit): string {
  if (unit === "cm") {
    const cm = Math.round((mm / 10) * 10) / 10;
    return String(cm);
  }
  return String(Math.round(mm));
}

/** Format a length (given in mm) with its unit suffix, e.g. "3 cm" / "30 mm". */
export function fmtLen(mm: number, unit: SizeUnit): string {
  return `${fmtLenNum(mm, unit)} ${unit}`;
}

/** Format a width × height pair (both in mm) with a single unit suffix. */
export function fmtPair(wmm: number, hmm: number, unit: SizeUnit): string {
  return `${fmtLenNum(wmm, unit)} × ${fmtLenNum(hmm, unit)} ${unit}`;
}
