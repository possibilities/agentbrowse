import type { TerminalColors } from "@opentui/core";

const RAMP_BLEND = {
  accent: 0.85,
  secondary: 0.75,
  dim: 0.5,
  divider: 0.3,
  surface: 0.12,
} as const;

export const RAMP_FALLBACK = {
  background: "#1c1c1c",
  surface: "#353535",
  divider: "#585858",
  dim: "#8a8a8a",
  secondary: "#bcbcbc",
  accent: "#d0d0d0",
  foreground: "#eeeeee",
  focus: "#7dd3fc",
  error: "#e5484d",
  backdrop: "#00000033",
} as const;

export type Ramp = { -readonly [Key in keyof typeof RAMP_FALLBACK]: string };

const LIGHT_FALLBACK_FOREGROUND = "#262626";

/** Derive the fxnk Ramp from the host terminal and update it live. */
export function hostRamp(colors: TerminalColors | null): Ramp {
  const focus = ansi(colors, 4, 12) ?? RAMP_FALLBACK.focus;
  const error = ansi(colors, 1, 9) ?? RAMP_FALLBACK.error;
  const detectedForeground = terminalColor(colors?.defaultForeground);
  const detectedBackground = terminalColor(colors?.defaultBackground);
  if (!detectedForeground && !detectedBackground) return { ...RAMP_FALLBACK, focus, error };

  const background = detectedBackground ?? RAMP_FALLBACK.background;
  const foreground =
    detectedForeground ??
    (detectedBackground && isLight(detectedBackground)
      ? LIGHT_FALLBACK_FOREGROUND
      : RAMP_FALLBACK.foreground);
  const step = (amount: number) => mixHexColors(background, foreground, amount);
  return {
    background,
    surface: step(RAMP_BLEND.surface),
    divider: step(RAMP_BLEND.divider),
    dim: step(RAMP_BLEND.dim),
    secondary: step(RAMP_BLEND.secondary),
    accent: step(RAMP_BLEND.accent),
    foreground,
    focus,
    error,
    backdrop: RAMP_FALLBACK.backdrop,
  };
}

/** Keep the first frame on the terminal's exact native canvas while its RGB is unknown. */
export function startupSurfaceBackground(
  colors: TerminalColors | null,
  palettePending: boolean,
): string {
  return palettePending ? "transparent" : hostRamp(colors).background;
}

export function mixHexColors(base: string, tint: string, amount: number): string {
  const channel = (offset: number) => {
    const from = Number.parseInt(base.slice(offset, offset + 2), 16);
    const to = Number.parseInt(tint.slice(offset, offset + 2), 16);
    return Math.round(from + (to - from) * amount)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

function terminalColor(color: string | null | undefined): string | null {
  if (!color || !/^#[0-9a-f]{6}$/iu.test(color)) return null;
  return color.toLowerCase();
}

function isLight(color: string): boolean {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  return red * 0.299 + green * 0.587 + blue * 0.114 > 128;
}

function ansi(colors: TerminalColors | null, normal: number, bright: number): string | null {
  return terminalColor(colors?.palette[normal]) ?? terminalColor(colors?.palette[bright]);
}
