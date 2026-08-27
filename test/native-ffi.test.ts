import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { connectionDescriptor } from "../client/connection.ts";
import { defaultNativeLibraryPath, NativeLiveViewSession } from "../src/opentui/native.ts";

const PUBLIC_HEADER = fileURLToPath(new URL("../include/agentbrowse_live_view.h", import.meta.url));
const EXPORT_LIST = fileURLToPath(new URL("../platform/macos/live_view.exports", import.meta.url));

test("Darwin export list matches every function in the public ABI header", () => {
  const headerSymbols = [
    ...readFileSync(PUBLIC_HEADER, "utf8").matchAll(/\b(ab_live_view_[a-z_]+)\s*\(/gu),
  ].map((match) => match[1]!);
  expect(exportedSymbols()).toEqual([...new Set(headerSymbols)].sort());
});

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

function exportedSymbols(): string[] {
  return readFileSync(EXPORT_LIST, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((symbol) => symbol.replace(/^_/u, ""))
    .sort();
}
