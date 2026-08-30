import { expect, test } from "bun:test";

import { cdpJsonEndpoint, normalizeDebuggerUrl } from "../client/cdp.ts";
import {
  greenSamples,
  matchesCalibration,
  parseProbeArgs,
  percentile,
  probeDocumentUrl,
  summarize,
} from "../tools/live-view-latency.ts";

test("latency probe options retain controlled measurement defaults", () => {
  expect(parseProbeArgs(["native-feel-test"], 0x1234)).toEqual({
    target: "native-feel-test",
    samples: 60,
    warmup: 5,
    timeoutMs: 2_000,
    quietMs: 1_000,
    captureFps: 25,
    cadenceSeconds: 5,
    cadenceMode: "cell",
    seed: 0x1234,
    kinds: ["key", "pointer"],
    modes: ["cell", "viewport"],
    scenario: "current",
    json: false,
  });
  expect(
    parseProbeArgs(
      [
        "native-feel-test",
        "--samples",
        "12",
        "--warmup",
        "0",
        "--kind",
        "pointer",
        "--mode",
        "cell",
        "--capture-fps",
        "30",
        "--cadence-mode",
        "viewport",
        "--quiet-ms",
        "100",
        "--seed",
        "7",
        "--scenario",
        "fps30-cpu8",
        "--json",
      ],
      1,
    ),
  ).toMatchObject({
    samples: 12,
    warmup: 0,
    kinds: ["pointer"],
    modes: ["cell"],
    captureFps: 30,
    cadenceMode: "viewport",
    quietMs: 100,
    seed: 7,
    scenario: "fps30-cpu8",
    json: true,
  });
});

test("latency distributions use interpolated percentiles", () => {
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

test("the decoded probe samples a calibrated three-by-three grid", () => {
  const rgba = Uint8Array.from(
    Array.from({ length: 9 }, (_, index) => [index, index + 10, index + 20, 255]).flat(),
  );
  expect(greenSamples(rgba)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18]);
  const thresholds = Array(9).fill(100);
  expect(matchesCalibration(Array(9).fill(200), thresholds, [0, 4, 8], "light")).toBe(true);
  expect(matchesCalibration(Array(9).fill(20), thresholds, [0, 4, 8], "dark")).toBe(true);
  expect(matchesCalibration([20, 20, 20, 20, 99, 20, 20, 20, 20], thresholds, [4], "light")).toBe(
    false,
  );
});

test("temporary CDP pages use the configured remote authority", () => {
  expect(cdpJsonEndpoint("http://browser:9223", "version")).toBe(
    "http://browser:9223/json/version",
  );
  expect(
    normalizeDebuggerUrl("http://browser:9223", "ws://127.0.0.1:9222/devtools/page/exact-target"),
  ).toBe("ws://browser:9223/devtools/page/exact-target");
  expect(probeDocumentUrl()).toContain("__agentbrowseLatencyProbe");
});
