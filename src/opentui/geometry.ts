import type { NativeFrameInfo } from "./native.ts";

const FALLBACK_CELL_WIDTH = 1;
const FALLBACK_CELL_HEIGHT = 2;
const MAX_OUTPUT_DIMENSION = 8192;
const MAX_OUTPUT_PIXELS = 32 * 1024 * 1024;

export interface CellPixelSize {
  width: number;
  height: number;
}

export interface FittedFrameGeometry {
  cellX: number;
  cellY: number;
  cellWidth: number;
  cellHeight: number;
  outputWidth: number;
  outputHeight: number;
  sourceWidth: number;
  sourceHeight: number;
  rotationDegrees: number;
}

export interface RemotePoint {
  x: number;
  y: number;
}

export function terminalCellPixels(context: {
  resolution?: { width: number; height: number } | null;
  terminalWidth?: number;
  terminalHeight?: number;
}): CellPixelSize {
  const resolution = context.resolution;
  const terminalWidth = context.terminalWidth ?? 0;
  const terminalHeight = context.terminalHeight ?? 0;
  if (
    resolution &&
    resolution.width > 0 &&
    resolution.height > 0 &&
    terminalWidth > 0 &&
    terminalHeight > 0
  ) {
    return {
      width: resolution.width / terminalWidth,
      height: resolution.height / terminalHeight,
    };
  }
  return { width: FALLBACK_CELL_WIDTH, height: FALLBACK_CELL_HEIGHT };
}

/** Fit a rotated frame to a cell rectangle, then bound native RGBA output. */
export function fitFrameGeometry(
  containerWidth: number,
  containerHeight: number,
  frame: Pick<
    NativeFrameInfo,
    "width" | "height" | "displayWidth" | "displayHeight" | "rotationDegrees"
  >,
  cellPixels: CellPixelSize,
): FittedFrameGeometry | null {
  if (
    containerWidth <= 0 ||
    containerHeight <= 0 ||
    frame.displayWidth <= 0 ||
    frame.displayHeight <= 0 ||
    cellPixels.width <= 0 ||
    cellPixels.height <= 0
  ) {
    return null;
  }

  const cellAspectRatio = cellPixels.height / cellPixels.width;
  const displayAspect = (frame.displayWidth / frame.displayHeight) * cellAspectRatio;
  const cellScale = Math.min(containerWidth / displayAspect, containerHeight);
  const cellWidth = Math.max(1, Math.round(displayAspect * cellScale));
  const cellHeight = Math.max(1, Math.round(cellScale));
  const availablePixelWidth = cellWidth * cellPixels.width;
  const availablePixelHeight = cellHeight * cellPixels.height;
  // Preserve decoded detail when the terminal's backing-pixel area is larger
  // than the stream. Ghostty scales Kitty textures with its linear GPU
  // sampler; pre-expanding here would only manufacture nearest-neighbor pixels
  // and increase terminal bandwidth.
  const pixelScale = Math.min(
    1,
    availablePixelWidth / frame.displayWidth,
    availablePixelHeight / frame.displayHeight,
  );
  let outputWidth = Math.max(1, Math.round(frame.displayWidth * pixelScale));
  let outputHeight = Math.max(1, Math.round(frame.displayHeight * pixelScale));
  const limitScale = Math.min(
    1,
    MAX_OUTPUT_DIMENSION / outputWidth,
    MAX_OUTPUT_DIMENSION / outputHeight,
    Math.sqrt(MAX_OUTPUT_PIXELS / (outputWidth * outputHeight)),
  );
  if (limitScale < 1) {
    outputWidth = Math.max(1, Math.floor(outputWidth * limitScale));
    outputHeight = Math.max(1, Math.floor(outputHeight * limitScale));
  }

  return {
    cellX: Math.floor((containerWidth - cellWidth) / 2),
    cellY: Math.floor((containerHeight - cellHeight) / 2),
    cellWidth,
    cellHeight,
    outputWidth,
    outputHeight,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
    rotationDegrees: frame.rotationDegrees,
  };
}

/** Map the center of one OpenTUI cell through the fitted and rotated frame. */
export function mapCellToRemote(
  localX: number,
  localY: number,
  geometry: FittedFrameGeometry,
): RemotePoint | null {
  if (
    localX < geometry.cellX ||
    localY < geometry.cellY ||
    localX >= geometry.cellX + geometry.cellWidth ||
    localY >= geometry.cellY + geometry.cellHeight
  ) {
    return null;
  }
  const normalizedX = (localX - geometry.cellX + 0.5) / geometry.cellWidth;
  const normalizedY = (localY - geometry.cellY + 0.5) / geometry.cellHeight;
  const displayWidth =
    geometry.rotationDegrees === 90 || geometry.rotationDegrees === 270
      ? geometry.sourceHeight
      : geometry.sourceWidth;
  const displayHeight =
    geometry.rotationDegrees === 90 || geometry.rotationDegrees === 270
      ? geometry.sourceWidth
      : geometry.sourceHeight;
  const displayX = clamp(Math.floor(normalizedX * displayWidth), 0, displayWidth - 1);
  const displayY = clamp(Math.floor(normalizedY * displayHeight), 0, displayHeight - 1);

  const point = inverseRotation(displayX, displayY, geometry);
  return {
    x: clamp(point.x, 0, Math.min(0xffff, geometry.sourceWidth - 1)),
    y: clamp(point.y, 0, Math.min(0xffff, geometry.sourceHeight - 1)),
  };
}

function inverseRotation(
  x: number,
  y: number,
  geometry: Pick<FittedFrameGeometry, "sourceWidth" | "sourceHeight" | "rotationDegrees">,
): RemotePoint {
  switch (geometry.rotationDegrees) {
    case 0:
      return { x, y };
    case 90:
      return { x: y, y: geometry.sourceHeight - 1 - x };
    case 180:
      return {
        x: geometry.sourceWidth - 1 - x,
        y: geometry.sourceHeight - 1 - y,
      };
    case 270:
      return { x: geometry.sourceWidth - 1 - y, y: x };
    default:
      return { x, y };
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
