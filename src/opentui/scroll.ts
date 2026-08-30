export const NEKO_SCROLL_UNITS_PER_NOTCH = 120;

export interface OpenTuiScrollDelta {
  deltaX: number;
  deltaY: number;
}

/**
 * Ghostty has already accumulated smooth motion to a terminal row or column
 * before emitting each SGR wheel report. Preserve that discrete notch when
 * translating it to Neko's 1/120-notch XI2 units.
 */
export function openTuiScrollDelta(
  direction: string | undefined,
  reportedDelta: number | undefined,
): OpenTuiScrollDelta | null {
  if (direction !== "left" && direction !== "right" && direction !== "up" && direction !== "down") {
    return null;
  }
  if (reportedDelta !== undefined && !Number.isFinite(reportedDelta)) return null;
  const notches = Math.max(1, reportedDelta ?? 1);
  const amount = clampI16(notches * NEKO_SCROLL_UNITS_PER_NOTCH);
  return {
    deltaX: direction === "left" ? -amount : direction === "right" ? amount : 0,
    deltaY: direction === "up" ? -amount : direction === "down" ? amount : 0,
  };
}

function clampI16(value: number): number {
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(value)));
}
