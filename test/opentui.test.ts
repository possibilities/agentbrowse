import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ImageRenderable } from "@opentui/core";
import {
  BrowserPickerController as ExportedBrowserPickerController,
  LiveViewRenderable,
  loadOpenTuiCore,
} from "agentbrowse/opentui";

import type { BrowserListEntry } from "../cli/farm.ts";
import { FXNK_MODAL_PADDING_X, pickerModalWidth, pickerRows } from "../examples/opentui-browser.ts";
import { BrowserPickerController } from "../src/opentui/browser-picker.ts";
import {
  type FittedFrameGeometry,
  fitFrameGeometry,
  mapCellToRemote,
  mapPixelToRemote,
  terminalCellPixels,
} from "../src/opentui/geometry.ts";
import {
  applyOpenTuiKeyTargetModifiers,
  isOpenTuiLocalShortcut,
  isOpenTuiModifierKey,
  keysymForOpenTuiKey,
  openTuiKeyLevelRemovesShift,
  openTuiKeyLevelRequiresShift,
  openTuiModifierSnapshot,
  openTuiPhysicalKeyIdentity,
  openTuiShortcutTranslation,
  X11_MODIFIER_KEYSYMS,
} from "../src/opentui/keysym.ts";
import {
  colorFgBgIsLight,
  FxnkThemeMonitor,
  type FxnkThemeMonitorPort,
  fxnkRamp,
  parseOsc11Response,
  resolveFxnkTheme,
} from "../src/opentui/palette.ts";
import { openTuiScrollDelta } from "../src/opentui/scroll.ts";

const LIVE_VIEW_RENDERABLE = fileURLToPath(
  new URL("../src/opentui/LiveViewRenderable.ts", import.meta.url),
);

const browserEntries: BrowserListEntry[] = [
  {
    name: "one",
    profile: "one",
    backend: "remote-docker",
    slot: 1,
    container: "agentbrowse-browser-one",
    state: "running",
    status: "Up",
    cdpUrl: "http://browser-host:9223",
    liveViewUrl: "http://127.0.0.1:18081",
    liveViewAccess: {
      mode: "ssh",
      remoteHost: "browser-host",
      remotePort: 18081,
    },
    slotConflict: false,
  },
  {
    name: "stopped",
    profile: "stopped",
    backend: "remote-docker",
    slot: 2,
    container: "agentbrowse-browser-stopped",
    state: "exited",
    status: "Exited (0)",
    cdpUrl: "http://browser-host:9224",
    liveViewUrl: "http://127.0.0.1:18082",
    liveViewAccess: {
      mode: "ssh",
      remoteHost: "browser-host",
      remotePort: 18082,
    },
    slotConflict: false,
  },
  {
    name: "two",
    profile: "two",
    backend: "remote-docker",
    slot: 3,
    container: "agentbrowse-browser-two",
    state: "running",
    status: "Up",
    cdpUrl: "http://browser-host:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    liveViewAccess: {
      mode: "ssh",
      remoteHost: "browser-host",
      remotePort: 18083,
    },
    slotConflict: false,
  },
];

test("package subpath preserves module and OpenTUI runtime identity", async () => {
  const core = await loadOpenTuiCore();
  expect(ExportedBrowserPickerController).toBe(BrowserPickerController);
  expect(core.ImageRenderable).toBe(ImageRenderable);
  expect(Object.getPrototypeOf(LiveViewRenderable.prototype).constructor).toBe(ImageRenderable);
});

test("OpenTUI leaves cursor presentation exclusively to the terminal host", () => {
  const source = readFileSync(LIVE_VIEW_RENDERABLE, "utf8");
  expect(source).not.toMatch(/\.cursor(?:Snapshot|Image)\s*\(/u);
});

test("OpenTUI reuses its worker-owned RGBA buffer only after NativeImage copies it", () => {
  const source = readFileSync(LIVE_VIEW_RENDERABLE, "utf8");
  expect(source).toMatch(
    /this\.frameConverter\.convert\([\s\S]+this\.rgbaScratch[\s\S]+NativeImage\.fromRgba\([\s\S]+this\.rgbaScratch = result\.bytes/u,
  );
  expect(source).toContain("this.rgbaScratch = undefined");
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

test("frame fitting leaves Retina enlargement to the terminal GPU", () => {
  const geometry = fitFrameGeometry(
    200,
    100,
    {
      width: 1920,
      height: 1080,
      displayWidth: 1920,
      displayHeight: 1080,
      rotationDegrees: 0,
    },
    { width: 10, height: 20 },
  );
  expect(geometry).toMatchObject({
    cellWidth: 200,
    cellHeight: 56,
    outputWidth: 1920,
    outputHeight: 1080,
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

test("pixel mouse mapping preserves exact DPR-2 device coordinates", () => {
  const cellPixels = terminalCellPixels({
    resolution: { width: 1600, height: 960 },
    terminalWidth: 80,
    terminalHeight: 24,
  });
  expect(cellPixels).toEqual({ width: 20, height: 40 });
  const geometry: FittedFrameGeometry = {
    cellX: 0,
    cellY: 0,
    cellWidth: 40,
    cellHeight: 15,
    outputWidth: 800,
    outputHeight: 600,
    sourceWidth: 800,
    sourceHeight: 600,
    rotationDegrees: 0,
  };

  expect(mapPixelToRemote(400, 200, geometry, cellPixels)).toEqual({
    x: 400,
    y: 200,
  });
  expect(mapPixelToRemote(-1, 200, geometry, cellPixels)).toBeNull();
  expect(mapPixelToRemote(800, 200, geometry, cellPixels)).toBeNull();
});

test("pixel mouse mapping respects letterboxing and frame rotation", () => {
  const geometry: FittedFrameGeometry = {
    cellX: 1,
    cellY: 2,
    cellWidth: 2,
    cellHeight: 4,
    outputWidth: 20,
    outputHeight: 80,
    sourceWidth: 4,
    sourceHeight: 2,
    rotationDegrees: 90,
  };
  const cellPixels = { width: 10, height: 20 };

  expect(mapPixelToRemote(9, 80, geometry, cellPixels)).toBeNull();
  expect(mapPixelToRemote(10, 40, geometry, cellPixels)).toEqual({
    x: 0,
    y: 1,
  });
  expect(mapPixelToRemote(29, 119, geometry, cellPixels)).toEqual({
    x: 3,
    y: 0,
  });
});

test("OpenTUI keys map to X11 special, printable, and Unicode keysyms", () => {
  expect(keysymForOpenTuiKey({ name: "left", shift: false })).toBe(0xff51n);
  expect(keysymForOpenTuiKey({ name: "f12", shift: false })).toBe(0xffc9n);
  expect(keysymForOpenTuiKey({ name: "!", shift: true })).toBe(BigInt("!".codePointAt(0)!));
  expect(openTuiKeyLevelRequiresShift({ name: "!", shift: false })).toBe(true);
  expect(openTuiKeyLevelRemovesShift({ name: "z", sequence: "z", shift: true })).toBe(true);
  expect(openTuiKeyLevelRequiresShift({ name: "c", sequence: "C", shift: false })).toBe(true);
  expect(keysymForOpenTuiKey({ name: "z", sequence: "Z", shift: true })).toBe(
    BigInt("Z".codePointAt(0)!),
  );
  expect(keysymForOpenTuiKey({ name: "λ", shift: false })).toBe(0x0100_03bbn);
});

test("OpenTUI wheel reports map to complete Neko notches without empty packets", () => {
  expect(openTuiScrollDelta("up", 1)).toEqual({ deltaX: 0, deltaY: -120 });
  expect(openTuiScrollDelta("down", 2)).toEqual({ deltaX: 0, deltaY: 240 });
  expect(openTuiScrollDelta("left", 1)).toEqual({ deltaX: -120, deltaY: 0 });
  expect(openTuiScrollDelta("right", 1)).toEqual({ deltaX: 120, deltaY: 0 });
  expect(openTuiScrollDelta(undefined, 1)).toBeNull();
  expect(openTuiScrollDelta("down", Number.NaN)).toBeNull();
  expect(openTuiScrollDelta("down", 1_000)).toEqual({ deltaX: 0, deltaY: 0x7fff });
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
    openTuiModifierSnapshot({
      ...common,
      meta: true,
      option: true,
      super: true,
    }),
  ).toMatchObject({ alt: true, meta: true });
});

test("OpenTUI translates macOS browser shortcuts by physical Kitty identity", () => {
  const commandC = {
    name: "ㅊ",
    baseCode: 99,
    super: true,
    option: false,
    meta: false,
    shift: false,
  };
  expect(openTuiPhysicalKeyIdentity(commandC)).toBe("base:99");
  expect(openTuiShortcutTranslation(commandC)).toEqual({
    keysym: 0x63n,
    forceControl: true,
    forceAlt: false,
    forceShift: false,
    removeShift: false,
    removeAlt: false,
    removeMeta: true,
  });
  expect(
    openTuiShortcutTranslation({
      name: "c",
      baseCode: "i".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: false,
    }),
  ).toMatchObject({ keysym: 0x63n });
  expect(
    openTuiShortcutTranslation({
      name: "z",
      sequence: "Z",
      baseCode: "z".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: true,
    }),
  ).toMatchObject({ keysym: 0x5an, forceShift: true });
  expect(
    openTuiShortcutTranslation({
      name: "C",
      baseCode: "c".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: false,
      capsLock: true,
    }),
  ).toMatchObject({ keysym: 0x63n, forceShift: false });
  expect(
    openTuiShortcutTranslation({
      name: "z",
      sequence: "z",
      baseCode: "z".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: true,
      capsLock: true,
    }),
  ).toMatchObject({ keysym: 0x5an, forceShift: true });
  expect(
    openTuiShortcutTranslation({
      name: "left",
      super: false,
      option: true,
      meta: false,
      shift: false,
    }),
  ).toEqual({
    keysym: 0xff51n,
    forceControl: true,
    forceAlt: false,
    forceShift: false,
    removeShift: false,
    removeAlt: true,
    removeMeta: false,
  });
  expect(
    openTuiShortcutTranslation({
      name: "up",
      super: true,
      option: false,
      meta: false,
      shift: false,
    }),
  ).toEqual({
    keysym: 0xff50n,
    forceControl: true,
    forceAlt: false,
    forceShift: false,
    removeShift: false,
    removeAlt: false,
    removeMeta: true,
  });
  expect(
    openTuiShortcutTranslation({
      name: "left",
      super: true,
      option: false,
      meta: false,
      shift: false,
    }),
  ).toEqual({
    keysym: 0xff50n,
    forceControl: false,
    forceAlt: false,
    forceShift: false,
    removeShift: false,
    removeAlt: false,
    removeMeta: true,
  });
  // Control-W/N/P/D would close the tab (and a single-tab session), open a
  // window, print, or bookmark in the guest; they stay untranslated Meta.
  for (const name of ["w", "n", "p", "d"]) {
    expect(
      openTuiShortcutTranslation({
        name,
        baseCode: name.codePointAt(0)!,
        super: true,
        option: false,
        meta: false,
        shift: false,
      }),
    ).toBeNull();
  }
  expect(
    openTuiShortcutTranslation({
      name: "[",
      baseCode: "[".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: false,
    }),
  ).toEqual({
    keysym: 0xff51n,
    forceControl: false,
    forceAlt: true,
    forceShift: false,
    removeShift: false,
    removeAlt: false,
    removeMeta: true,
  });
  expect(
    openTuiShortcutTranslation({
      name: "]",
      baseCode: "]".codePointAt(0)!,
      super: true,
      option: false,
      meta: false,
      shift: true,
    }),
  ).toMatchObject({ keysym: 0xff53n, forceAlt: true, forceShift: true, removeMeta: true });
  expect(
    openTuiShortcutTranslation({
      name: "[",
      baseCode: "[".codePointAt(0)!,
      super: true,
      option: true,
      meta: false,
      shift: false,
    }),
  ).toBeNull();
  expect(
    openTuiShortcutTranslation({
      name: "backspace",
      super: false,
      option: true,
      meta: false,
      shift: false,
    }),
  ).toEqual({
    keysym: 0xff08n,
    forceControl: true,
    forceAlt: false,
    forceShift: false,
    removeShift: false,
    removeAlt: true,
    removeMeta: false,
  });
  expect(
    openTuiShortcutTranslation({
      name: "delete",
      super: false,
      option: false,
      meta: true,
      shift: true,
    }),
  ).toMatchObject({ keysym: 0xffffn, forceControl: true, forceShift: true, removeAlt: true });
  expect(
    openTuiShortcutTranslation({
      name: "backspace",
      super: true,
      option: false,
      meta: false,
      shift: false,
    }),
  ).toBeNull();
  expect(isOpenTuiLocalShortcut({ name: "v", super: true })).toBe(true);
  expect(isOpenTuiLocalShortcut({ name: "q", super: true })).toBe(true);
});

test("translated OpenTUI modifiers preserve Shift and replace only their trigger", () => {
  const physical = {
    shift: true,
    control: false,
    alt: true,
    meta: true,
    hyper: true,
  };
  expect(
    applyOpenTuiKeyTargetModifiers(physical, {
      keysym: 0x43n,
      forceControl: true,
      forceAlt: false,
      forceShift: true,
      removeShift: false,
      removeAlt: false,
      removeMeta: true,
    }),
  ).toEqual({
    shift: true,
    control: true,
    alt: true,
    meta: false,
    hyper: true,
  });
  expect(
    applyOpenTuiKeyTargetModifiers(physical, {
      keysym: 0xff51n,
      forceControl: true,
      forceAlt: false,
      forceShift: false,
      removeShift: false,
      removeAlt: true,
      removeMeta: false,
    }),
  ).toEqual({
    shift: true,
    control: true,
    alt: false,
    meta: true,
    hyper: true,
  });
  expect(
    applyOpenTuiKeyTargetModifiers(
      { ...physical, control: false },
      {
        keysym: 0xff50n,
        forceControl: false,
        forceAlt: false,
        forceShift: false,
        removeShift: false,
        removeAlt: false,
        removeMeta: true,
      },
    ),
  ).toEqual({
    shift: true,
    control: false,
    alt: true,
    meta: false,
    hyper: true,
  });
  expect(
    applyOpenTuiKeyTargetModifiers(
      { ...physical, alt: false },
      {
        keysym: 0xff51n,
        forceControl: false,
        forceAlt: true,
        forceShift: false,
        removeShift: false,
        removeAlt: false,
        removeMeta: true,
      },
    ),
  ).toEqual({
    shift: true,
    control: false,
    alt: true,
    meta: false,
    hyper: true,
  });
  expect(
    applyOpenTuiKeyTargetModifiers(physical, {
      keysym: 0x7an,
      forceControl: false,
      forceAlt: false,
      forceShift: false,
      removeShift: true,
      removeAlt: false,
      removeMeta: false,
    }),
  ).toEqual({
    shift: false,
    control: false,
    alt: true,
    meta: true,
    hyper: true,
  });
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

test("fxnk picker bodies own exactly one horizontal cell on each side", () => {
  const ramp = fxnkRamp("dark");
  const common = {
    open: true,
    choices: [],
    selectedIndex: -1,
  } as const;
  const loading = pickerRows({ ...common, loading: true, error: null }, 1, ramp).plain;
  const failure = pickerRows(
    {
      ...common,
      loading: false,
      error: "Browser host is offline or unreachable",
    },
    1,
    ramp,
  ).plain;
  const empty = pickerRows({ ...common, loading: false, error: null }, 1, ramp).plain;

  expect(FXNK_MODAL_PADDING_X).toBe(1);
  expect(loading).toEqual(["loading…"]);
  expect(failure).toEqual(["Browser host is offline or unreachable"]);
  expect(empty).toEqual(["no browser targets"]);
  expect(pickerModalWidth(failure, 100) - failure[0]!.length).toBe(4);
});

test("fxnk ramps are fx's fixed indexed dark and light roles", () => {
  const dark = fxnkRamp("dark");
  const light = fxnkRamp("light");
  expect(dark.background.intent).toBe("default");
  expect(light.background.intent).toBe("default");
  expect([
    dark.foreground.slot,
    dark.accent.slot,
    dark.secondary.slot,
    dark.dim.slot,
    dark.divider.slot,
  ]).toEqual([255, 252, 250, 245, 240]);
  expect([
    light.foreground.slot,
    light.accent.slot,
    light.secondary.slot,
    light.dim.slot,
    light.divider.slot,
  ]).toEqual([235, 238, 241, 247, 250]);
  expect(dark.focus.slot).toBe(4);
  expect(light.focus.slot).toBe(4);
  expect(dark.error.slot).toBe(1);
  expect(light.error.slot).toBe(1);
});

test("fxnk theme parsing matches fx's OSC 11 and COLORFGBG thresholds", () => {
  expect(parseOsc11Response("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toEqual({
    light: true,
    hex: "#ffffff",
  });
  expect(parseOsc11Response("\x1b]11;rgb:0/0/0\x07")).toEqual({
    light: false,
    hex: "#000000",
  });
  expect(parseOsc11Response("\x1b]11;rgb:FFFF/ABCD/0000\x07")).toEqual({
    light: true,
    hex: "#ffab00",
  });
  expect(parseOsc11Response("\x1b]11;RGB:ffff/ffff/ffff\x07")).toBeNull();
  expect(parseOsc11Response("\x1b]10;rgb:ffff/ffff/ffff\x07")).toBeNull();
  expect(colorFgBgIsLight("0;8")).toBe(true);
  expect(colorFgBgIsLight("0;7")).toBe(false);
  expect(colorFgBgIsLight("1;3;15")).toBe(true);
  expect(colorFgBgIsLight("0;999")).toBe(false);
});

test("fxnk resolution uses FX_THEME, OSC 11, COLORFGBG, then dark", async () => {
  const explicitPort = new FakeThemePort();
  expect(
    await resolveFxnkTheme(explicitPort, { FX_THEME: "LIGHT", COLORFGBG: "0;0" }, 1),
  ).toMatchObject({
    theme: "light",
    source: "FX_THEME",
    explicit: true,
  });
  expect(explicitPort.writes).toEqual([]);

  const oscPort = new FakeThemePort("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
  expect(await resolveFxnkTheme(oscPort, { COLORFGBG: "15;0" }, 20)).toMatchObject({
    theme: "light",
    source: "osc11",
    background: "#ffffff",
  });
  expect(oscPort.writes).toEqual(["\x1b]11;?\x1b\\"]);

  expect(await resolveFxnkTheme(new FakeThemePort(), { COLORFGBG: "0;15" }, 1)).toMatchObject({
    theme: "light",
    source: "COLORFGBG",
  });
  expect(await resolveFxnkTheme(new FakeThemePort(), {}, 1)).toMatchObject({
    theme: "dark",
    source: "default",
  });
});

test("live fxnk changes use a fenced OSC 11 sample and swap once", () => {
  const port = new FakeThemePort();
  const updates: string[] = [];
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    (resolution) => updates.push(resolution.theme),
  );
  monitor.start();
  try {
    expect(port.feedInput("\x1b[?997;2n")).toBe(true);
    expect(port.writes.at(-1)).toBe("\x1b[c");
    expect(port.feedInput("\x1b[?1;2c")).toBe(true);
    expect(port.writes.at(-1)).toBe("\x1b]11;?\x1b\\\x1b[c");
    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    expect(port.feedInput("\x1b[?1;2c")).toBe(true);
    expect(updates).toEqual(["light"]);
  } finally {
    monitor.dispose();
  }
});

test("a newer 997 notification drops an in-flight sample and starts a fresh fenced cycle", () => {
  const port = new FakeThemePort();
  const updates: Array<{ theme: string; background: string | null }> = [];
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    ({ theme, background }) => updates.push({ theme, background }),
  );
  monitor.start();
  try {
    port.feedInput("\x1b[?997;2n");
    port.feedInput("\x1b[?1;2c");
    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    port.feedInput("\x1b[?997;1n");

    // The fence closes the obsolete light sample and immediately begins a
    // newly fenced dark cycle. Nothing from the obsolete cycle is applied.
    port.feedInput("\x1b[?1;2c");
    expect(updates).toEqual([]);
    expect(port.writes.at(-1)).toBe("\x1b[c");

    port.feedInput("\x1b[?1;2c");
    port.emitOsc("\x1b]11;rgb:1111/1111/1111\x1b\\");
    port.feedInput("\x1b[?1;2c");
    expect(updates).toEqual([{ theme: "dark", background: "#111111" }]);
  } finally {
    monitor.dispose();
  }
});

test("a response fence arriving before OSC 11 keeps the bounded sample open", () => {
  const port = new FakeThemePort();
  const updates: string[] = [];
  const monitor = new FxnkThemeMonitor(
    port,
    { theme: "dark", background: "#000000", source: "osc11", explicit: false },
    ({ theme }) => updates.push(theme),
  );
  monitor.start();
  try {
    port.feedInput("\x1b[?997;2n");
    port.feedInput("\x1b[?1;2c");
    port.feedInput("\x1b[?1;2c");
    expect(updates).toEqual([]);

    port.emitOsc("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
    port.feedInput("\x1b[?1;2c");
    expect(updates).toEqual(["light"]);
  } finally {
    monitor.dispose();
  }
});

test("the reference app resolves light before its first stable empty frame", async () => {
  const chunks: Uint8Array[] = [];
  let output = "";
  let outputBeforeThemeReply = "";
  let answered = false;
  let resolveFirstFrame: (() => void) | undefined;
  const firstFrame = new Promise<void>((resolve) => {
    resolveFirstFrame = resolve;
  });
  const terminal = new Bun.Terminal({
    cols: 80,
    rows: 24,
    data: (_terminal, chunk) => {
      const copy = chunk.slice();
      chunks.push(copy);
      const text = new TextDecoder().decode(copy, { stream: true });
      output += text;
      if (!answered && text.includes("\x1b]11;?")) {
        answered = true;
        setTimeout(() => {
          outputBeforeThemeReply = output;
          terminal.write("\x1b]11;rgb:ffff/ffff/ffff\x1b\\");
        }, 80);
      }
      if (output.includes("no browser")) resolveFirstFrame?.();
    },
  });
  const child = Bun.spawn([process.execPath, "run", "examples/opentui-browser.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: {
      ...Bun.env,
      FX_THEME: undefined,
      COLORFGBG: undefined,
      COLORTERM: "truecolor",
      TERM: "xterm-256color",
    },
    terminal,
  });

  try {
    await Promise.race([
      firstFrame,
      Bun.sleep(2_000).then(() => {
        throw new Error("reference app did not paint its empty state");
      }),
    ]);
    await Bun.sleep(350);
  } finally {
    terminal.write("\u0003");
    await child.exited;
    terminal.close();
  }

  const startup = new TextDecoder().decode(Buffer.concat(chunks));
  expect(outputBeforeThemeReply).not.toContain("no browser");
  expect(startup.match(/no browser/gu)).toHaveLength(1);
  expect(startup).toContain("\u001b[38;5;247m");
  expect(startup).not.toContain("\u001b[38;5;245m");
  expect(startup).not.toContain("\u001b]4;");
});

class FakeThemePort implements FxnkThemeMonitorPort {
  readonly writes: string[] = [];
  private readonly oscHandlers = new Set<(sequence: string) => void>();
  private readonly inputHandlers: Array<(sequence: string) => boolean> = [];

  constructor(private readonly immediateOsc: string | null = null) {}

  write(sequence: string): void {
    this.writes.push(sequence);
    if (this.immediateOsc && sequence.includes("\x1b]11;?")) {
      queueMicrotask(() => this.emitOsc(this.immediateOsc!));
    }
  }

  subscribeOsc(handler: (sequence: string) => void): () => void {
    this.oscHandlers.add(handler);
    return () => this.oscHandlers.delete(handler);
  }

  prependInputHandler(handler: (sequence: string) => boolean): void {
    this.inputHandlers.unshift(handler);
  }

  removeInputHandler(handler: (sequence: string) => boolean): void {
    const index = this.inputHandlers.indexOf(handler);
    if (index !== -1) this.inputHandlers.splice(index, 1);
  }

  emitOsc(sequence: string): void {
    for (const handler of this.oscHandlers) handler(sequence);
  }

  feedInput(sequence: string): boolean {
    return this.inputHandlers.some((handler) => handler(sequence));
  }
}
