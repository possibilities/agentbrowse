import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { connectionDescriptor } from "../client/connection.ts";
import { defaultNativeLibraryPath, NativeLiveViewSession } from "../src/opentui/native.ts";

const PUBLIC_HEADER = fileURLToPath(new URL("../include/agentbrowse_live_view.h", import.meta.url));
const EXPORT_LIST = fileURLToPath(new URL("../platform/macos/live_view.exports", import.meta.url));
const NATIVE_BRIDGE = fileURLToPath(new URL("../platform/macos/native_bridge.mm", import.meta.url));
const NATIVE_SESSION = fileURLToPath(new URL("../src/session/session.zig", import.meta.url));
const PACKAGE_JSON = fileURLToPath(new URL("../package.json", import.meta.url));
const NEGOTIATION_FIXTURE = fileURLToPath(
  new URL("./fixtures/native-negotiation.ts", import.meta.url),
);
const ABI_V2_FIXTURE = fileURLToPath(new URL("./fixtures/native-v2-compat.ts", import.meta.url));
const ABI_V2_COMPARISON = join(
  resolve("zig-out/comparisons/03-control-admission"),
  "lib",
  "libagentbrowse-live-view.dylib",
);

test("named build prefixes select preserved Live View comparison artifacts", () => {
  const prefix = "zig-out/comparisons/00-baseline-debug";
  expect(defaultNativeLibraryPath({ AGENTBROWSE_LIVE_VIEW_PREFIX: ` ${prefix} ` })).toBe(
    join(resolve(prefix), "lib", "libagentbrowse-live-view.dylib"),
  );
});

test("production native build commands use ReleaseFast", () => {
  const scripts = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")).scripts as Record<string, string>;
  expect(scripts["native:build"]).toContain("-Doptimize=ReleaseFast");
  expect(scripts["native:build:app"]).toContain("-Doptimize=ReleaseFast");
});

test("Darwin export list matches every function in the public ABI header", () => {
  const headerSymbols = [
    ...readFileSync(PUBLIC_HEADER, "utf8").matchAll(/\b(ab_live_view_[a-z_]+)\s*\(/gu),
  ].map((match) => match[1]!);
  expect(exportedSymbols()).toEqual([...new Set(headerSymbols)].sort());
});

test("input telemetry is an additive ABI v3 snapshot with fixed layouts", () => {
  const header = readFileSync(PUBLIC_HEADER, "utf8");
  const enumConstants = [...header.matchAll(/^\s+(AB_LIVE_VIEW_[A-Z0-9_]+)\s*=/gmu)].map(
    (match) => match[1]!,
  );
  expect(header).toContain("#define AB_LIVE_VIEW_ABI_VERSION 3u");
  expect(new Set(enumConstants).size).toBe(enumConstants.length);
  expect(header).toContain("AB_LIVE_VIEW_INPUT_KIND_COUNT = 5");
  expect(header).toContain("ABLiveViewInputKindMetrics kinds[AB_LIVE_VIEW_INPUT_KIND_COUNT]");
  expect(header).toContain("ab_live_view_session_input_metrics(");
});

test("embeddable native sessions never write process diagnostics", () => {
  expect(readFileSync(NATIVE_BRIDGE, "utf8")).not.toMatch(/fprintf\s*\(\s*stderr/gu);
  expect(readFileSync(NATIVE_SESSION, "utf8")).not.toContain("std.debug.print");
});

test("AppKit recovers focused Command-held key-up events and removes its monitor", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toContain("addLocalMonitorForEventsMatchingMask:NSEventMaskKeyUp");
  expect(bridge).toMatch(/event\.window != window[\s\S]+window\.firstResponder != inputView/u);
  expect(bridge).toMatch(/\[inputView keyUp:event\];\s*return nil;/u);
  expect(bridge).toContain("[NSEvent removeMonitor:commandKeyUpMonitor]");
});

test("paste readiness leaves the native session monitor before draining Zig input", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toMatch(
    /@synchronized \(session\)[\s\S]+callbacks = session\.callbacks;[\s\S]+\}\s*\/\/ Paste readiness[\s\S]+callbacks\.on_paste_ready/u,
  );
});

test.skipIf(!existsSync(ABI_V2_COMPARISON))(
  "current OpenTUI wrapper keeps ABI v2 comparison libraries usable",
  () => {
    const child = Bun.spawnSync([process.execPath, ABI_V2_FIXTURE, ABI_V2_COMPARISON]);
    expect(child.exitCode).toBe(0);
    expect(new TextDecoder().decode(child.stderr)).toBe("");
    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({ input: null });
  },
);

test.skipIf(!existsSync(defaultNativeLibraryPath()))(
  "dylib exports only the public Live View ABI",
  () => {
    const result = Bun.spawnSync(["nm", "-gU", defaultNativeLibraryPath()]);
    expect(result.exitCode).toBe(0);
    const symbols = new TextDecoder()
      .decode(result.stdout)
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => line.trim().split(/\s+/u).at(-1)!)
      .sort();
    expect(symbols).toEqual(exportedSymbols().map((symbol) => `_${symbol}`));
  },
);

test.skipIf(!existsSync(defaultNativeLibraryPath()))(
  "polling ABI creates and destroys a headless Live View session",
  () => {
    const session = NativeLiveViewSession.create(
      connectionDescriptor({ name: "testing" }, "http://127.0.0.1:9"),
    );
    try {
      expect(session.snapshot()).toMatchObject({
        lifecycle: "idle",
        latestFrameGeneration: 0n,
      });
      expect(session.cursorSnapshot()).toEqual({
        imageAvailable: false,
        positionAvailable: false,
        width: 0,
        height: 0,
        hotspotX: 0,
        hotspotY: 0,
        positionX: 0,
        positionY: 0,
        imageByteLength: 0,
        generation: 0n,
        imageGeneration: 0n,
        positionGeneration: 0n,
      });
      expect(session.cursorImage()).toBeNull();
      expect(session.metrics().input).toEqual({
        queueDepth: 0,
        queueCapacity: 256,
        epoch: 0n,
        controlWaitNs: 0n,
        controlWaitCount: 0n,
        move: zeroInputKindMetrics(),
        button: zeroInputKindMetrics(),
        scroll: zeroInputKindMetrics(),
        key: zeroInputKindMetrics(),
        paste: zeroInputKindMetrics(),
      });
      expect(session.status()).toBe("Ready");
      expect(session.acquireFrame(0n)).toBeNull();
      // Exercise immediate teardown with NSURLSession work outstanding. Native
      // destruction must quiesce callbacks before releasing the Zig session.
      session.connect();
    } finally {
      session.close();
    }
  },
);

test.skipIf(!existsSync(defaultNativeLibraryPath()))(
  "native offer negotiation stays silent and closes without a monitor deadlock",
  async () => {
    const child = Bun.spawn([process.execPath, NEGOTIATION_FIXTURE], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = new Response(child.stdout).text();
    const errors = new Response(child.stderr).text();
    const completed = await Promise.race([
      Promise.all([child.exited, output, errors]),
      Bun.sleep(5_000).then(() => null),
    ]);
    if (!completed) {
      child.kill();
      await child.exited;
      throw new Error("native negotiation did not close within 5 seconds");
    }
    const [exitCode, stdout, stderr] = completed;
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      loginAccepted: true,
      websocketAuthorized: true,
      selectedMain: true,
      candidateSent: true,
      answered: true,
      answerUsesPayload: true,
      closed: true,
    });
  },
);

function exportedSymbols(): string[] {
  return readFileSync(EXPORT_LIST, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((symbol) => symbol.replace(/^_/u, ""))
    .sort();
}

function zeroInputKindMetrics() {
  return {
    attempted: 0n,
    queued: 0n,
    sent: 0n,
    coalesced: 0n,
    controlDropped: 0n,
    sendFailed: 0n,
    duplicateSuppressed: 0n,
  };
}
