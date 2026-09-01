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
const NATIVE_WRAPPER = fileURLToPath(new URL("../src/opentui/native.ts", import.meta.url));
const LIVE_VIEW_ABI = fileURLToPath(new URL("../src/live_view_abi.zig", import.meta.url));
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

test("input telemetry is an additive ABI snapshot with fixed layouts", () => {
  const header = readFileSync(PUBLIC_HEADER, "utf8");
  const enumConstants = [...header.matchAll(/^\s+(AB_LIVE_VIEW_[A-Z0-9_]+)\s*=/gmu)].map(
    (match) => match[1]!,
  );
  expect(new Set(enumConstants).size).toBe(enumConstants.length);
  expect(header).toContain("AB_LIVE_VIEW_INPUT_KIND_COUNT = 5");
  expect(header).toContain("ABLiveViewInputKindMetrics kinds[AB_LIVE_VIEW_INPUT_KIND_COUNT]");
  expect(header).toContain("ab_live_view_session_input_metrics(");
});

test("every ABI version bound comes from one shared constant", async () => {
  // The session wrapper and the conversion Worker open the same dylib from
  // different threads. When they carried separate copies of this range they
  // drifted on an additive bump, and the Worker's rejection is recorded
  // permanently by the pool as a silent synchronous fallback for every frame.
  const { MAX_ABI_VERSION, MIN_ABI_VERSION } = await import("../src/opentui/abi-version.ts");

  // Discover the consumers rather than listing them. A hand-written list is how
  // the Worker's private copy of the bound went unnoticed in the first place,
  // so anything that opens the library must be found here automatically.
  const found = Bun.spawnSync(["git", "grep", "-l", "dlopen(", "--", "*.ts", ":(exclude)test/"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
  });
  expect(found.exitCode).toBe(0);
  const consumers = new TextDecoder()
    .decode(found.stdout)
    .trim()
    .split("\n")
    .filter((line) => line && !line.endsWith("abi-version.ts"));
  // Tests legitimately dlopen the library to probe it, so they are excluded —
  // which also keeps this assertion's own needle from matching this file.
  expect(consumers).toEqual(
    expect.arrayContaining(["src/opentui/native.ts", "src/opentui/frame-conversion-worker.ts"]),
  );
  for (const consumer of consumers) {
    const source = readFileSync(fileURLToPath(new URL(`../${consumer}`, import.meta.url)), "utf8");
    expect(source).toContain('from "./abi-version.ts"');
    expect(source).not.toMatch(/^const (?:MIN_ABI_VERSION|MAX_ABI_VERSION|ABI_VERSION)\s*=/mu);
  }

  // The shared maximum is the ABI the native library actually reports, and the
  // header consumers compile against.
  expect(readFileSync(LIVE_VIEW_ABI, "utf8")).toContain(
    `const abi_version: u32 = ${MAX_ABI_VERSION};`,
  );
  expect(readFileSync(PUBLIC_HEADER, "utf8")).toContain(
    `#define AB_LIVE_VIEW_ABI_VERSION ${MAX_ABI_VERSION}u`,
  );
  expect(MIN_ABI_VERSION).toBeLessThanOrEqual(MAX_ABI_VERSION);
});

test.skipIf(!existsSync(defaultNativeLibraryPath()))(
  "the conversion Worker accepts the ABI the built dylib reports",
  async () => {
    const worker = new Worker(
      new URL("../src/opentui/frame-conversion-worker.ts", import.meta.url).href,
    );
    try {
      const message = await new Promise<{ infrastructureError: string | null }>(
        (resolve, reject) => {
          worker.onmessage = (event: MessageEvent) => resolve(event.data);
          worker.onerror = (event) => reject(event);
          worker.postMessage({
            type: "initialize",
            id: 1,
            libraryPath: defaultNativeLibraryPath(),
          });
          const timer = setTimeout(
            () => reject(new Error("conversion worker did not answer initialize")),
            5_000,
          );
          worker.addEventListener("message", () => clearTimeout(timer), { once: true });
          worker.addEventListener("error", () => clearTimeout(timer), { once: true });
        },
      );
      // An infrastructure error here is not a thrown failure at runtime: the
      // pool records it and silently runs every conversion on the event loop.
      expect(message.infrastructureError).toBeNull();
    } finally {
      worker.terminate();
    }
  },
);

test("the guest clipboard observation is an additive ABI snapshot", () => {
  const header = readFileSync(PUBLIC_HEADER, "utf8");
  // The version itself is pinned to the shared constant by the test above; a
  // second literal here would be one more copy to drift.
  expect(header).toContain("ab_live_view_session_clipboard_snapshot(");
  expect(header).toContain("ab_live_view_session_copy_clipboard_text(");
  // The wrapper's declared size is checked against the library at runtime
  // rather than here: `clipboardSnapshot()` rejects a struct_size that is not
  // exactly its own constant, which is what catches a SHRUNK struct — the case
  // a buffer_too_small result cannot catch. A string match on the constant
  // would pass while the layouts diverged.
  expect(readFileSync(NATIVE_WRAPPER, "utf8")).toMatch(/structSize !== CLIPBOARD_SNAPSHOT_SIZE/u);
});

test("embeddable native sessions never write process diagnostics", () => {
  expect(readFileSync(NATIVE_BRIDGE, "utf8")).not.toMatch(/fprintf\s*\(\s*stderr/gu);
  expect(readFileSync(NATIVE_SESSION, "utf8")).not.toContain("std.debug.print");
});

test("AppKit forwards browser key equivalents and pairs every focused key-up", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toContain("KLIsLocalCommandShortcut");
  expect(bridge).toContain("self.window.firstResponder != self");
  expect(bridge).toMatch(/Command-V is owned locally[\s\S]+KLIsLocalCommandShortcut/u);
  expect(bridge).toContain("event.modifierFlags & ~NSEventModifierFlagCommand");
  expect(bridge).toContain("[self keyDown:event]");
  expect(bridge).toContain("addLocalMonitorForEventsMatchingMask:NSEventMaskKeyUp");
  expect(bridge).toMatch(/event\.window != window[\s\S]+window\.firstResponder != inputView/u);
  expect(bridge).toMatch(/\[inputView keyUp:event\];\s*return nil;/u);
  expect(bridge).toContain("[NSEvent removeMonitor:commandKeyUpMonitor]");
});

test("AppKit observes frame dimensions without copying decoded I420 planes", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toContain("self.frameSink.copyFrames = NO");
  expect(bridge).toMatch(
    /if \(!_copyFrames\)[\s\S]+_callbacks\.on_frame_metadata[\s\S]+return;[\s\S]+\[frame\.buffer toI420\]/u,
  );
});

test("paste readiness leaves the native session monitor before draining Zig input", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toMatch(
    /@synchronized \(session\)[\s\S]+callbacks = session\.callbacks;[\s\S]+\}\s*\/\/ Paste readiness[\s\S]+callbacks\.on_paste_ready/u,
  );
});

test("AppKit writes new guest clipboard observations to the Mac pasteboard", () => {
  const bridge = readFileSync(NATIVE_BRIDGE, "utf8");
  expect(bridge).toContain("refreshClipboardObservation");
  // The generation is claimed before the copy, so text this view cannot present
  // is not retried on every timer tick.
  expect(bridge).toMatch(/_clipboardGeneration = snapshot\.generation;[\s\S]+copy_clipboard_text/u);
  expect(bridge).toMatch(
    /\[pasteboard clearContents\];\s+\[pasteboard setString:text forType:NSPasteboardTypeString\];/u,
  );
  // A cleared or oversized observation must leave the operator's own clipboard
  // alone rather than emptying it.
  expect(bridge).toMatch(/if \(!hasText \|\| snapshot\.text_byte_length == 0[\s\S]+return;/u);
  expect(bridge).toMatch(
    /refreshCursorObservation\];\s+\[strongSelf\.inputView refreshClipboardObservation\];/u,
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
      expect(session.clipboardSnapshot()).toEqual({
        textAvailable: false,
        textByteLength: 0,
        generation: 0n,
      });
      expect(session.clipboardText()).toBeNull();
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
