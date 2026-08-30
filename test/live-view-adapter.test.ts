import { expect, test } from "bun:test";

import {
  openTuiAssetPath,
  parseAdapterProbeArgs,
  percentile,
  summarize,
} from "../tools/live-view-adapter.ts";

test("adapter probe options retain a bounded native-feel default", () => {
  expect(parseAdapterProbeArgs(["native-feel-test"])).toEqual({
    target: "native-feel-test",
    seconds: 10,
    warmupSeconds: 3,
    pollFps: 30,
    rendererFps: 30,
    scenario: "current",
    jsonPath: expect.stringContaining("zig-out/live-view-adapter.json"),
  });
  expect(
    parseAdapterProbeArgs([
      "native-feel-test",
      "--seconds",
      "5",
      "--warmup-seconds",
      "0",
      "--poll-fps",
      "15",
      "--renderer-fps",
      "60",
      "--scenario",
      "shared-memory",
      "--json",
      "zig-out/custom.json",
    ]),
  ).toMatchObject({
    seconds: 5,
    warmupSeconds: 0,
    pollFps: 15,
    rendererFps: 60,
    scenario: "shared-memory",
    jsonPath: expect.stringContaining("zig-out/custom.json"),
  });
});

test("adapter probe distributions use interpolated percentiles", () => {
  expect(percentile([1, 2, 3, 100], 0.5)).toBe(2.5);
  expect(percentile([1, 2, 3, 100], 0.95)).toBeCloseTo(85.45);
  expect(summarize([100, 1, 3, 2])).toEqual({
    count: 4,
    min: 1,
    mean: 26.5,
    p50: 2.5,
    p95: expect.closeTo(85.45),
    max: 100,
  });
  expect(summarize([])).toBeNull();
});

test("adapter probe resolves the exact OpenTUI native override layout", () => {
  if (process.platform !== "darwin" || process.arch !== "arm64") return;
  expect(openTuiAssetPath("/comparison/assets")).toBe(
    "/comparison/assets/@opentui/core-darwin-arm64/libopentui.dylib",
  );
});
