import { expect, test } from "bun:test";
import { ImageRenderable } from "@opentui/core";
import {
  BrowserPickerController as ExportedBrowserPickerController,
  LiveViewRenderable,
} from "agentbrowse/opentui";

import type { BrowserListEntry } from "../cli/farm.ts";
import { BrowserPickerController } from "../src/opentui/browser-picker.ts";
import {
  type FittedFrameGeometry,
  fitFrameGeometry,
  mapCellToRemote,
  terminalCellPixels,
} from "../src/opentui/geometry.ts";
import {
  isOpenTuiModifierKey,
  keysymForOpenTuiKey,
  openTuiModifierSnapshot,
  X11_MODIFIER_KEYSYMS,
} from "../src/opentui/keysym.ts";
import {
  hostRamp,
  mixHexColors,
  RAMP_FALLBACK,
  startupSurfaceBackground,
} from "../src/opentui/palette.ts";

const browserEntries: BrowserListEntry[] = [
  {
    name: "one",
    slot: 1,
    container: "agentbrowse-browser-one",
    state: "running",
    status: "Up",
    cdpUrl: "http://artbird:9223",
    liveViewUrl: "http://127.0.0.1:18081",
    slotConflict: false,
  },
  {
    name: "stopped",
    slot: 2,
    container: "agentbrowse-browser-stopped",
    state: "exited",
    status: "Exited (0)",
    cdpUrl: "http://artbird:9224",
    liveViewUrl: "http://127.0.0.1:18082",
    slotConflict: false,
  },
  {
    name: "two",
    slot: 3,
    container: "agentbrowse-browser-two",
    state: "running",
    status: "Up",
    cdpUrl: "http://artbird:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    slotConflict: false,
  },
];

test("package subpath preserves module and OpenTUI runtime identity", () => {
  expect(ExportedBrowserPickerController).toBe(BrowserPickerController);
  expect(Object.getPrototypeOf(LiveViewRenderable.prototype).constructor).toBe(ImageRenderable);
});

test("frame fitting preserves browser aspect in terminal pixels", () => {
  const cellPixels = terminalCellPixels({
    resolution: { width: 800, height: 480 },
    terminalWidth: 80,
    terminalHeight: 24,
  });
  expect(cellPixels).toEqual({ width: 10, height: 20 });

  const geometry = fitFrameGeometry(
    80,
    24,
    {
      width: 1920,
      height: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      rotationDegrees: 0,
    },
    cellPixels,
  );
  expect(geometry).toMatchObject({
    cellX: 0,
    cellY: 0,
    cellWidth: 80,
    cellHeight: 23,
    outputWidth: 800,
    outputHeight: 450,
  });
});

test("mouse mapping rejects letterbox cells and maps cell centers", () => {
  const geometry = fitFrameGeometry(
    40,
    40,
    {
      width: 1920,
      height: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      rotationDegrees: 0,
    },
    { width: 1, height: 2 },
  )!;
  expect(mapCellToRemote(20, 0, geometry)).toBeNull();
  const center = mapCellToRemote(
    20,
    geometry.cellY + Math.floor(geometry.cellHeight / 2),
    geometry,
  )!;
  expect(center.x).toBeGreaterThan(950);
  expect(center.x).toBeLessThan(1_050);
  expect(center.y).toBeGreaterThan(450);
  expect(center.y).toBeLessThan(650);
});

test("mouse mapping inverts WebRTC frame rotation", () => {
  const geometry: FittedFrameGeometry = {
    cellX: 0,
    cellY: 0,
    cellWidth: 1,
    cellHeight: 2,
    outputWidth: 1,
    outputHeight: 2,
    sourceWidth: 2,
    sourceHeight: 1,
    rotationDegrees: 90,
  };
  expect(mapCellToRemote(0, 0, geometry)).toEqual({ x: 0, y: 0 });
  expect(mapCellToRemote(0, 1, geometry)).toEqual({ x: 1, y: 0 });
});

test("OpenTUI keys map to X11 special, printable, and Unicode keysyms", () => {
  expect(keysymForOpenTuiKey({ name: "left", shift: false })).toBe(0xff51n);
  expect(keysymForOpenTuiKey({ name: "f12", shift: false })).toBe(0xffc9n);
  expect(keysymForOpenTuiKey({ name: "!", shift: true })).toBe(BigInt("1".codePointAt(0)!));
  expect(keysymForOpenTuiKey({ name: "λ", shift: false })).toBe(0x0100_03bbn);
});

test("modifier-only events reconcile their own press and release state", () => {
  const common = {
    shift: true,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
  };
  expect(isOpenTuiModifierKey({ name: "rightshift" })).toBe(true);
  expect(
    openTuiModifierSnapshot({
      ...common,
      name: "rightshift",
      eventType: "release",
    }).shift,
  ).toBe(false);
  expect(
    openTuiModifierSnapshot({
      ...common,
      shift: false,
      name: "leftctrl",
      eventType: "press",
    }).control,
  ).toBe(true);
});

test("OpenTUI legacy meta maps to Alt and platform super maps to Meta", () => {
  expect(X11_MODIFIER_KEYSYMS).toMatchObject({ alt: 0xffe9n, meta: 0xffe7n });
  const common = {
    name: "x",
    eventType: "press" as const,
    shift: false,
    ctrl: false,
    meta: false,
    option: false,
    super: false,
    hyper: false,
  };
  expect(openTuiModifierSnapshot({ ...common, meta: true })).toEqual({
    shift: false,
    control: false,
    alt: true,
    meta: false,
    hyper: false,
  });
  expect(openTuiModifierSnapshot({ ...common, super: true })).toEqual({
    shift: false,
    control: false,
    alt: false,
    meta: true,
    hyper: false,
  });
  expect(
    openTuiModifierSnapshot({ ...common, meta: true, option: true, super: true }),
  ).toMatchObject({ alt: true, meta: true });
});

test("Browser-target picker skips disabled rows and closes before choosing", async () => {
  const observedOpen: boolean[] = [];
  const picker = new BrowserPickerController({ list: async () => browserEntries }, (state) =>
    observedOpen.push(state.open),
  );
  await picker.open();
  expect(picker.state().selectedIndex).toBe(0);
  picker.move(1);
  expect(picker.state().selectedIndex).toBe(2);
  const choice = picker.choose();
  expect(choice?.name).toBe("two");
  expect(picker.state().open).toBe(false);
  expect(observedOpen.at(-1)).toBe(false);
});

test("closing a Browser-target picker suppresses an in-flight discovery result", async () => {
  let resolveList!: (entries: readonly BrowserListEntry[]) => void;
  let discoverySignal: AbortSignal | undefined;
  const pending = new Promise<readonly BrowserListEntry[]>((resolve) => {
    resolveList = resolve;
  });
  const picker = new BrowserPickerController({
    list: (signal) => {
      discoverySignal = signal;
      return pending;
    },
  });
  const opening = picker.open();
  picker.close();
  expect(discoverySignal?.aborted).toBe(true);
  resolveList(browserEntries);
  await opening;
  expect(picker.state()).toMatchObject({ open: false, choices: [] });
});

test("a stalled Browser-target discovery becomes a bounded picker error", async () => {
  let discoverySignal: AbortSignal | undefined;
  const picker = new BrowserPickerController(
    {
      list: (signal) => {
        discoverySignal = signal;
        return new Promise<readonly BrowserListEntry[]>(() => {});
      },
    },
    undefined,
    5,
  );

  await picker.open();

  expect(discoverySignal?.aborted).toBe(true);
  expect(picker.state()).toMatchObject({
    open: true,
    loading: false,
    choices: [],
    error: "Browser target discovery timed out after 5 ms",
  });
});

test("fxnk palette derives grayscale roles from the host canvas", () => {
  expect(mixHexColors("#000000", "#ffffff", 0.5)).toBe("#808080");
  expect(hostRamp(null)).toEqual(RAMP_FALLBACK);
  const light = hostRamp({
    defaultForeground: "#101010",
    defaultBackground: "#f0f0f0",
    palette: [],
  } as never);
  expect(light.background).toBe("#f0f0f0");
  expect(light.foreground).toBe("#101010");
  expect(light.dim).toBe("#808080");
});

test("a pending startup palette preserves the terminal's native background", () => {
  expect(startupSurfaceBackground(null, true)).toBe("transparent");
  expect(startupSurfaceBackground(null, false)).toBe(RAMP_FALLBACK.background);
  expect(
    startupSurfaceBackground(
      {
        defaultForeground: "#f0f0f0",
        defaultBackground: "#0d1117",
        palette: [],
      } as never,
      false,
    ),
  ).toBe("#0d1117");
});
