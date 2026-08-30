#!/usr/bin/env bun

import { readFile, stat } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { BrowserListEntry } from "../cli/farm.ts";
import { browserFarm } from "../cli/runtime.ts";
import { TemporaryCdpPage } from "../client/cdp.ts";
import { connectionDescriptor } from "../client/connection.ts";
import { LiveViewTunnel } from "../client/tunnel.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";
import {
  defaultNativeLibraryPath,
  type NativeFrameInfo,
  type NativeLiveViewMetrics,
  NativeLiveViewSession,
} from "../src/opentui/native.ts";

const SCHEMA_VERSION = 1;
const SAMPLE_WIDTH = 3;
const SAMPLE_HEIGHT = 3;
const SAMPLE_COUNT = SAMPLE_WIDTH * SAMPLE_HEIGHT;
const CENTER_SAMPLE = 4;
const PROBE_KEYSYM = 0x61n;
const DARK_VALUE = 24;
const LIGHT_VALUE = 232;
const POLL_INTERVAL_MS = 1;
const EVENT_LOOP_INTERVAL_MS = 5;
const CONNECT_TIMEOUT_MS = 15_000;

type InputKind = "key" | "pointer";
type PageMode = "cell" | "viewport";

export interface ProbeOptions {
  target: string;
  samples: number;
  warmup: number;
  timeoutMs: number;
  quietMs: number;
  captureFps: number;
  cadenceSeconds: number;
  cadenceMode: PageMode;
  seed: number;
  kinds: readonly InputKind[];
  modes: readonly PageMode[];
  scenario: string;
  json: boolean;
}

export interface Distribution {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

interface FrameSample {
  info: NativeFrameInfo;
  greens: readonly number[];
  observedAt: number;
}

interface PixelCalibration {
  dark: readonly number[];
  light: readonly number[];
  thresholds: readonly number[];
}

interface TrialResult {
  ordinal: number;
  warmup: boolean;
  status:
    | "completed"
    | "input-rejected"
    | "pixel-timeout"
    | "input-not-observed"
    | "visual-without-input";
  latencyMs: number | null;
  submitCallMs: number;
  frameTimestampDeltaMs: number | null;
  generationDelta: number | null;
  framesObserved: number;
  randomizedDelayMs: number;
}

interface ProbeCaseResult {
  kind: InputKind;
  mode: PageMode;
  completed: number;
  rejected: number;
  timeouts: number;
  inputNotObserved: number;
  contaminated: number;
  latencyMs: Distribution | null;
  submitCallMs: Distribution | null;
  frameTimestampDeltaMs: Distribution | null;
  generationDelta: Distribution | null;
  trials: readonly TrialResult[];
}

interface CadenceResult {
  durationMs: number;
  observedFrames: number;
  deliveredFps: number;
  generationGaps: number;
  frameTimestampIntervalMs: Distribution | null;
  localObservationIntervalMs: Distribution | null;
  measuredPollSleepMs: Distribution | null;
}

interface ProbePageState {
  ready: boolean;
  focused: boolean;
  visible: boolean;
  armed: { kind?: string; token?: string } | null;
  last: { kind?: string; token?: string } | null;
}

class ProbeUsageError extends Error {}

class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (Math.imul(this.state, 1_664_525) + 1_013_904_223) >>> 0;
    return this.state / 0x1_0000_0000;
  }
}

class EventLoopGapMonitor {
  private readonly gaps: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private previous = 0;

  start(): void {
    if (this.timer) return;
    this.previous = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.gaps.push(Math.max(0, now - this.previous - EVENT_LOOP_INTERVAL_MS));
      this.previous = now;
    }, EVENT_LOOP_INTERVAL_MS);
  }

  stop(): Distribution | null {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return summarize(this.gaps);
  }
}

class FrameObserver {
  generation = 0n;
  observedFrames = 0;
  generationGaps = 0;
  readonly timestampIntervalsMs: number[] = [];
  readonly localIntervalsMs: number[] = [];
  readonly pollSleepsMs: number[] = [];
  private lastTimestampUs: bigint | null = null;
  private lastObservedAt: number | null = null;

  constructor(private readonly session: NativeLiveViewSession) {}

  async next(deadline: number): Promise<FrameSample | null> {
    while (performance.now() < deadline) {
      const lease = this.session.acquireFrame(this.generation);
      if (!lease) {
        const sleepStartedAt = performance.now();
        await Bun.sleep(POLL_INTERVAL_MS);
        this.pollSleepsMs.push(performance.now() - sleepStartedAt);
        continue;
      }
      try {
        const info = lease.info();
        const greens = greenSamples(lease.convertRgba(SAMPLE_WIDTH, SAMPLE_HEIGHT));
        const observedAt = performance.now();
        if (this.generation > 0n && info.generation > this.generation + 1n) {
          this.generationGaps += Number(info.generation - this.generation - 1n);
        }
        if (info.generation === this.generation + 1n) {
          if (this.lastTimestampUs !== null && info.timestampUs > this.lastTimestampUs) {
            this.timestampIntervalsMs.push(Number(info.timestampUs - this.lastTimestampUs) / 1_000);
          }
          if (this.lastObservedAt !== null) {
            this.localIntervalsMs.push(observedAt - this.lastObservedAt);
          }
        }
        this.generation = info.generation;
        this.lastTimestampUs = info.timestampUs;
        this.lastObservedAt = observedAt;
        this.observedFrames += 1;
        return { info, greens, observedAt };
      } finally {
        lease.close();
      }
    }
    return null;
  }

  async waitFor(
    expected: "dark" | "light",
    calibration: PixelCalibration,
    indices: readonly number[],
    timeoutMs: number,
  ): Promise<FrameSample | null> {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      const sample = await this.next(deadline);
      if (!sample) return null;
      if (matchesCalibration(sample.greens, calibration.thresholds, indices, expected)) {
        return sample;
      }
    }
    return null;
  }

  async observeFor(durationMs: number): Promise<CadenceResult> {
    const startedAt = performance.now();
    const initialFrames = this.observedFrames;
    const initialGaps = this.generationGaps;
    const timestampStart = this.timestampIntervalsMs.length;
    const localStart = this.localIntervalsMs.length;
    const pollStart = this.pollSleepsMs.length;
    const deadline = startedAt + durationMs;
    while (performance.now() < deadline) await this.next(deadline);
    const elapsed = performance.now() - startedAt;
    const observedFrames = this.observedFrames - initialFrames;
    return {
      durationMs: elapsed,
      observedFrames,
      deliveredFps: elapsed > 0 ? (observedFrames * 1_000) / elapsed : 0,
      generationGaps: this.generationGaps - initialGaps,
      frameTimestampIntervalMs: summarize(this.timestampIntervalsMs.slice(timestampStart)),
      localObservationIntervalMs: summarize(this.localIntervalsMs.slice(localStart)),
      measuredPollSleepMs: summarize(this.pollSleepsMs.slice(pollStart)),
    };
  }
}

export function parseProbeArgs(argv: readonly string[], now = Date.now()): ProbeOptions {
  if (argv.includes("-h") || argv.includes("--help")) throw new ProbeUsageError(usage());
  const target = argv[0];
  if (!target || target.startsWith("--")) throw new ProbeUsageError("a Browser target is required");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(target)) {
    throw new ProbeUsageError(`invalid Browser target: ${target}`);
  }
  let samples = 60;
  let warmup = 5;
  let timeoutMs = 2_000;
  let quietMs = 1_000;
  let captureFps = 25;
  let cadenceSeconds = 5;
  let cadenceMode: PageMode = "cell";
  let seed = now >>> 0;
  let kinds: readonly InputKind[] = ["key", "pointer"];
  let modes: readonly PageMode[] = ["cell", "viewport"];
  let scenario = "current";
  let json = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--json") {
      json = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ProbeUsageError(`${argument} requires a value`);
    }
    if (argument === "--samples") samples = integer(value, argument, 1, 500);
    else if (argument === "--warmup") warmup = integer(value, argument, 0, 100);
    else if (argument === "--timeout-ms") timeoutMs = integer(value, argument, 100, 10_000);
    else if (argument === "--quiet-ms") quietMs = integer(value, argument, 0, 10_000);
    else if (argument === "--capture-fps") captureFps = integer(value, argument, 1, 240);
    else if (argument === "--cadence-seconds") {
      cadenceSeconds = integer(value, argument, 1, 60);
    } else if (argument === "--cadence-mode") {
      if (value === "cell" || value === "viewport") cadenceMode = value;
      else throw new ProbeUsageError("--cadence-mode must be cell or viewport");
    } else if (argument === "--seed") seed = integer(value, argument, 0, 0xffff_ffff);
    else if (argument === "--scenario") scenario = label(value, argument);
    else if (argument === "--kind") {
      if (value === "key" || value === "pointer") kinds = [value];
      else if (value === "both") kinds = ["key", "pointer"];
      else throw new ProbeUsageError("--kind must be key, pointer, or both");
    } else if (argument === "--mode") {
      if (value === "cell" || value === "viewport") modes = [value];
      else if (value === "both") modes = ["cell", "viewport"];
      else throw new ProbeUsageError("--mode must be cell, viewport, or both");
    } else throw new ProbeUsageError(`unknown option: ${argument}`);
    index += 1;
  }
  return {
    target,
    samples,
    warmup,
    timeoutMs,
    quietMs,
    captureFps,
    cadenceSeconds,
    cadenceMode,
    seed,
    kinds,
    modes,
    scenario,
    json,
  };
}

export function summarize(values: readonly number[]): Distribution | null {
  const finite = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  return {
    count: finite.length,
    min: finite[0]!,
    mean: finite.reduce((sum, value) => sum + value, 0) / finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    max: finite[finite.length - 1]!,
  };
}

export function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) throw new RangeError("percentile requires at least one value");
  if (quantile < 0 || quantile > 1) throw new RangeError("quantile must be between zero and one");
  const position = (sortedValues.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  return sortedValues[lower]! * (1 - fraction) + sortedValues[upper]! * fraction;
}

export function greenSamples(rgba: Uint8Array): number[] {
  if (rgba.byteLength !== SAMPLE_COUNT * 4) {
    throw new RangeError(`expected ${SAMPLE_COUNT} RGBA samples, received ${rgba.byteLength / 4}`);
  }
  return Array.from({ length: SAMPLE_COUNT }, (_, index) => rgba[index * 4 + 1]!);
}

export function matchesCalibration(
  greens: readonly number[],
  thresholds: readonly number[],
  indices: readonly number[],
  expected: "dark" | "light",
): boolean {
  return indices.every((index) =>
    expected === "light"
      ? greens[index]! >= thresholds[index]!
      : greens[index]! < thresholds[index]!,
  );
}

export function probeDocumentUrl(): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PROBE_HTML)}`;
}

async function main(options: ProbeOptions): Promise<Record<string, unknown>> {
  const target = await targetNamed(options.target);
  const page = await TemporaryCdpPage.open(target.cdpUrl, probeDocumentUrl());
  let tunnel: LiveViewTunnel | null = null;
  let session: NativeLiveViewSession | null = null;
  const monitor = new EventLoopGapMonitor();
  try {
    await waitForPage(page);

    tunnel = await LiveViewTunnel.open(target);
    const liveView = loadAgentbrowseConfig().liveView;
    const descriptor = connectionDescriptor(target, tunnel.baseUrl, {
      labelPrefix: liveView.labelPrefix,
      username: liveView.username,
      password: liveView.password,
      readOnly: false,
    });
    const libraryPath = defaultNativeLibraryPath();
    session = NativeLiveViewSession.create(descriptor, libraryPath);
    session.connect();
    const snapshot = await waitForSession(session);
    session.requestControl();
    await waitForAuthorization(session);

    const observer = new FrameObserver(session);
    monitor.start();
    await ensurePageFocus(page, session, snapshot.remoteWidth, snapshot.remoteHeight);
    const calibration = await calibrate(page, observer, options);
    const cadence = await measureCadence(page, observer, options);
    const random = new SeededRandom(options.seed);
    const cases: ProbeCaseResult[] = [];
    for (const mode of options.modes) {
      for (const kind of options.kinds) {
        cases.push(
          await runCase(
            page,
            session,
            observer,
            calibration,
            options,
            random,
            mode,
            kind,
            snapshot.remoteWidth,
            snapshot.remoteHeight,
          ),
        );
      }
    }
    const endMetrics = session.metrics();
    const eventLoopGapMs = monitor.stop();
    const build = await buildProvenance(libraryPath, session.abiVersion());
    return {
      schemaVersion: SCHEMA_VERSION,
      measuredAt: new Date().toISOString(),
      scenario: options.scenario,
      target: {
        name: target.name,
        backend: target.backend,
        container: target.container,
        remoteWidth: snapshot.remoteWidth,
        remoteHeight: snapshot.remoteHeight,
        declaredCaptureFps: options.captureFps,
      },
      build,
      parameters: {
        samples: options.samples,
        warmup: options.warmup,
        timeoutMs: options.timeoutMs,
        quietMs: options.quietMs,
        randomizedCaptureIntervalMs: 1_000 / options.captureFps,
        cadenceSeconds: options.cadenceSeconds,
        cadenceMode: options.cadenceMode,
        seed: options.seed,
        pollIntervalMs: POLL_INTERVAL_MS,
        sampleGrid: `${SAMPLE_WIDTH}x${SAMPLE_HEIGHT}`,
        modes: options.modes,
        kinds: options.kinds,
      },
      calibration,
      cadence,
      cases,
      eventLoopGapMs,
      frameTimestampIntervalMs: summarize(observer.timestampIntervalsMs),
      localFrameObservationIntervalMs: summarize(observer.localIntervalsMs),
      nativeMetrics: serializableMetrics(endMetrics),
      limitations: [
        "submit-to-decoded observation; AppKit Metal presentation and terminal presentation are excluded",
        "the physical floor includes up to 16.7 ms for Chromium paint, one capture interval, encode, transport, jitter buffer, decode, and poll observation",
        "frame timestamps are local jitter-buffer render times and are used only for cadence deltas",
        "the probe cannot attribute capture, encode, network, jitter-buffer, and decode sub-stages",
      ],
    };
  } finally {
    monitor.stop();
    session?.close();
    await page.close();
    await tunnel?.close();
  }
}

async function targetNamed(name: string): Promise<BrowserListEntry> {
  const target = (await browserFarm().list()).find((entry) => entry.name === name);
  if (!target) throw new Error(`unknown Browser target: ${name}`);
  if (target.state !== "running") throw new Error(`${target.container} is not running`);
  if (target.slotConflict) throw new Error(`${target.name} has a slot conflict`);
  return target;
}

async function waitForPage(page: TemporaryCdpPage): Promise<void> {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    try {
      const state = await page.evaluate<ProbePageState>(
        "window.__agentbrowseLatencyProbe?.state() ?? null",
      );
      if (state?.ready) return;
    } catch {
      // Navigation swaps execution contexts once. Retry only within the deadline.
    }
    await Bun.sleep(10);
  }
  throw new Error("latency probe page did not become ready");
}

async function waitForSession(session: NativeLiveViewSession) {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const snapshot = session.snapshot();
    if (
      snapshot.lifecycle === "connected" &&
      snapshot.dataOpen &&
      snapshot.latestFrameGeneration > 0n &&
      snapshot.remoteWidth > 0 &&
      snapshot.remoteHeight > 0
    ) {
      return snapshot;
    }
    if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "closed") {
      throw new Error(`Live View failed while connecting: ${session.status()}`);
    }
    await Bun.sleep(10);
  }
  throw new Error(`Live View did not connect within ${CONNECT_TIMEOUT_MS} ms: ${session.status()}`);
}

async function waitForAuthorization(session: NativeLiveViewSession): Promise<void> {
  const deadline = performance.now() + CONNECT_TIMEOUT_MS;
  while (performance.now() < deadline) {
    const snapshot = session.snapshot();
    if (snapshot.authorized && snapshot.dataOpen) return;
    if (snapshot.lifecycle === "failed" || snapshot.lifecycle === "closed") break;
    await Bun.sleep(10);
  }
  throw new Error("Live View did not grant control before measurement");
}

async function ensurePageFocus(
  page: TemporaryCdpPage,
  session: NativeLiveViewSession,
  remoteWidth: number,
  remoteHeight: number,
): Promise<void> {
  let state = await pageState(page);
  if (state.focused && state.visible) return;
  const x = Math.floor(remoteWidth / 2);
  const y = Math.floor(remoteHeight / 2);
  session.movePointer(x, y);
  session.setPointerButton(0, true);
  session.setPointerButton(0, false);
  await Bun.sleep(50);
  state = await pageState(page);
  if (!state.focused || !state.visible) {
    throw new Error("temporary probe page could not gain focus through Live View input");
  }
}

async function pageState(page: TemporaryCdpPage): Promise<ProbePageState> {
  return await page.evaluate<ProbePageState>("window.__agentbrowseLatencyProbe.state()");
}

async function calibrate(
  page: TemporaryCdpPage,
  observer: FrameObserver,
  options: ProbeOptions,
): Promise<PixelCalibration> {
  await setBaseline(page, "viewport", DARK_VALUE);
  await Bun.sleep(options.quietMs);
  const dark = await observer.next(performance.now() + options.timeoutMs);
  if (!dark) throw new Error("could not sample the settled dark calibration frame");
  await setBaseline(page, "viewport", LIGHT_VALUE);
  await Bun.sleep(options.quietMs);
  const light = await observer.next(performance.now() + options.timeoutMs);
  if (!light) throw new Error("could not sample the settled light calibration frame");
  const thresholds = dark.greens.map((value, index) => (value + light.greens[index]!) / 2);
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    if (light.greens[index]! - dark.greens[index]! < 64) {
      throw new Error(`probe calibration contrast is too low at sample ${index}`);
    }
  }
  return { dark: dark.greens, light: light.greens, thresholds };
}

async function measureCadence(
  page: TemporaryCdpPage,
  observer: FrameObserver,
  options: ProbeOptions,
): Promise<CadenceResult> {
  await setBaseline(page, options.cadenceMode, DARK_VALUE);
  await Bun.sleep(options.quietMs);
  await page.evaluate(
    `window.__agentbrowseLatencyProbe.startCadence(${JSON.stringify(options.cadenceMode)})`,
  );
  try {
    return await observer.observeFor(options.cadenceSeconds * 1_000);
  } finally {
    await page.evaluate("window.__agentbrowseLatencyProbe.stopCadence()");
    await setBaseline(page, "viewport", DARK_VALUE);
    await Bun.sleep(options.quietMs);
  }
}

async function runCase(
  page: TemporaryCdpPage,
  session: NativeLiveViewSession,
  observer: FrameObserver,
  calibration: PixelCalibration,
  options: ProbeOptions,
  random: SeededRandom,
  mode: PageMode,
  kind: InputKind,
  remoteWidth: number,
  remoteHeight: number,
): Promise<ProbeCaseResult> {
  const indices = mode === "viewport" ? [...Array(SAMPLE_COUNT).keys()] : [CENTER_SAMPLE];
  const trials: TrialResult[] = [];
  let pointerVariant = false;
  for (let ordinal = 0; ordinal < options.warmup + options.samples; ordinal += 1) {
    await setBaseline(page, mode, DARK_VALUE);
    await Bun.sleep(options.quietMs);
    const baseline = await observer.waitFor("dark", calibration, indices, options.timeoutMs);
    if (!baseline) throw new Error(`${mode}/${kind} baseline did not reach the decoded stream`);
    await ensurePageFocus(page, session, remoteWidth, remoteHeight);
    const randomizedDelayMs = random.next() * (1_000 / options.captureFps);
    await Bun.sleep(randomizedDelayMs);
    const ready = await pageState(page);
    if (!ready.focused || !ready.visible) {
      await ensurePageFocus(page, session, remoteWidth, remoteHeight);
    }
    if (ready.armed !== null || ready.last !== null) {
      throw new Error(`${mode}/${kind} page state drifted before trial ${ordinal}`);
    }
    const token = `${mode}-${kind}-${ordinal}-${options.seed}`;
    let pointerPoint: { x: number; y: number } | null = null;
    if (kind === "pointer") {
      pointerVariant = !pointerVariant;
      pointerPoint = {
        x: Math.floor(remoteWidth * (pointerVariant ? 0.4 : 0.6)),
        y: Math.floor(remoteHeight * (pointerVariant ? 0.55 : 0.65)),
      };
    }
    await page.evaluate(
      `window.__agentbrowseLatencyProbe.arm(${JSON.stringify(kind)}, ${JSON.stringify(token)}, ${LIGHT_VALUE}, ${JSON.stringify(pointerPoint)})`,
    );
    const beforeFrames = observer.observedFrames;
    const submittedAt = performance.now();
    let accepted: boolean;
    if (kind === "key") {
      accepted = session.setKey(PROBE_KEYSYM, true);
      session.setKey(PROBE_KEYSYM, false);
    } else {
      accepted = session.movePointer(pointerPoint!.x, pointerPoint!.y);
    }
    const submitCallMs = performance.now() - submittedAt;
    if (!accepted) {
      trials.push({
        ordinal,
        warmup: ordinal < options.warmup,
        status: "input-rejected",
        latencyMs: null,
        submitCallMs,
        frameTimestampDeltaMs: null,
        generationDelta: null,
        framesObserved: 0,
        randomizedDelayMs,
      });
      continue;
    }
    const response = await observer.waitFor("light", calibration, indices, options.timeoutMs);
    const state = await pageState(page);
    const inputObserved = state.last?.token === token && state.last.kind === kind;
    const status = response
      ? inputObserved
        ? "completed"
        : "visual-without-input"
      : inputObserved
        ? "pixel-timeout"
        : "input-not-observed";
    trials.push({
      ordinal,
      warmup: ordinal < options.warmup,
      status,
      latencyMs: response ? response.observedAt - submittedAt : null,
      submitCallMs,
      frameTimestampDeltaMs:
        response && response.info.timestampUs > baseline.info.timestampUs
          ? Number(response.info.timestampUs - baseline.info.timestampUs) / 1_000
          : null,
      generationDelta: response
        ? Number(response.info.generation - baseline.info.generation)
        : null,
      framesObserved: observer.observedFrames - beforeFrames,
      randomizedDelayMs,
    });
  }
  const measured = trials.filter((trial) => !trial.warmup);
  const completed = measured.filter((trial) => trial.status === "completed");
  return {
    kind,
    mode,
    completed: completed.length,
    rejected: measured.filter((trial) => trial.status === "input-rejected").length,
    timeouts: measured.filter((trial) => trial.status === "pixel-timeout").length,
    inputNotObserved: measured.filter((trial) => trial.status === "input-not-observed").length,
    contaminated: measured.filter((trial) => trial.status === "visual-without-input").length,
    latencyMs: summarize(
      completed.flatMap((trial) => (trial.latencyMs === null ? [] : [trial.latencyMs])),
    ),
    submitCallMs: summarize(measured.map((trial) => trial.submitCallMs)),
    frameTimestampDeltaMs: summarize(
      completed.flatMap((trial) =>
        trial.frameTimestampDeltaMs === null ? [] : [trial.frameTimestampDeltaMs],
      ),
    ),
    generationDelta: summarize(
      completed.flatMap((trial) => (trial.generationDelta === null ? [] : [trial.generationDelta])),
    ),
    trials,
  };
}

async function setBaseline(page: TemporaryCdpPage, mode: PageMode, value: number): Promise<void> {
  await page.evaluate(
    `window.__agentbrowseLatencyProbe.setBaseline(${JSON.stringify(mode)}, ${value})`,
  );
}

async function buildProvenance(libraryPath: string, abiVersion: number) {
  const prefix = resolve(dirname(dirname(libraryPath)));
  const file = await stat(libraryPath);
  const comparison = await readJson(join(prefix, "comparison.json"));
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "..") });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: join(import.meta.dir, ".."),
  });
  let macosVersion: string | null = null;
  try {
    const macos = Bun.spawnSync(["sw_vers", "-productVersion"]);
    if (macos.exitCode === 0) macosVersion = macos.stdout.toString().trim();
  } catch {
    // Non-macOS hosts do not provide sw_vers.
  }
  return {
    dylibPath: resolve(libraryPath),
    prefix,
    dylibBytes: file.size,
    abiVersion,
    comparison,
    sourceCommit: head.exitCode === 0 ? head.stdout.toString().trim() : null,
    sourceDirty: status.exitCode === 0 ? status.stdout.byteLength > 0 : null,
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: osRelease(),
      macosVersion,
    },
  };
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function serializableMetrics(metrics: NativeLiveViewMetrics): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(metrics, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
}

function integer(value: string, flag: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new ProbeUsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new ProbeUsageError(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function label(value: string, flag: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new ProbeUsageError(`${flag} must be a short lowercase label`);
  }
  return value;
}

function formatDistribution(value: Distribution | null): string {
  if (!value) return "no samples";
  return `p50 ${value.p50.toFixed(1)} ms  p95 ${value.p95.toFixed(1)} ms  max ${value.max.toFixed(1)} ms`;
}

function humanReport(report: Record<string, unknown>): string {
  const target = report.target as { name: string; backend: string };
  const cadence = report.cadence as CadenceResult;
  const cases = report.cases as ProbeCaseResult[];
  const lines = [
    `Live View latency: ${target.name} (${target.backend})`,
    `Cadence: ${cadence.deliveredFps.toFixed(1)} decoded fps, ${cadence.generationGaps} skipped generations`,
  ];
  for (const result of cases) {
    lines.push(
      `${result.mode}/${result.kind}: ${formatDistribution(result.latencyMs)}  (${result.completed}/${result.completed + result.rejected + result.timeouts + result.inputNotObserved + result.contaminated} completed)`,
    );
  }
  lines.push(
    `Event-loop gaps: ${formatDistribution(report.eventLoopGapMs as Distribution | null)}`,
  );
  return `${lines.join("\n")}\n`;
}

function usage(): string {
  return `Usage: bun run tools/live-view-latency.ts NAME [options]

Options:
  --samples N             Measured trials per case (default 60)
  --warmup N              Discarded warmup trials per case (default 5)
  --kind key|pointer|both Input path to measure (default both)
  --mode cell|viewport|both  Typing-like or full-frame paint (default both)
  --capture-fps N         Declared capture cadence for randomized starts (default 25)
  --quiet-ms N            Rate-control settling time between trials (default 1000)
  --timeout-ms N          Per-pixel transition deadline (default 2000)
  --cadence-seconds N     Continuous decoded-cadence sample (default 5)
  --cadence-mode cell|viewport  Cadence paint workload (default cell)
  --seed N                Reproducible phase-randomization seed
  --scenario LABEL        Capture/build scenario label (default current)
  --json                  Emit the full machine-readable report
`;
}

const PROBE_HTML = `<!doctype html>
<meta charset="utf-8">
<title>Agentbrowse latency probe</title>
<style>
  html, body { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  body { outline: none; }
  #cell { position: fixed; width: 128px; height: 128px; transform: translate(-50%, -50%); }
</style>
<body tabindex="0"><div id="cell"></div>
<script>
(() => {
  const cell = document.getElementById("cell");
  let mode = "viewport";
  let armed = null;
  let last = null;
  let cleanup = () => {};
  let cadence = false;
  const rgb = (value) => "rgb(" + value + "," + value + "," + value + ")";
  const positionCell = () => {
    const chromeTop = Math.max(0, window.outerHeight - window.innerHeight);
    cell.style.left = (window.outerWidth / 2) + "px";
    cell.style.top = (window.outerHeight / 2 - chromeTop) + "px";
  };
  const paint = (value) => {
    const color = rgb(value);
    document.documentElement.style.background = mode === "viewport" ? color : rgb(${DARK_VALUE});
    document.body.style.background = mode === "viewport" ? color : rgb(${DARK_VALUE});
    cell.style.display = mode === "cell" ? "block" : "none";
    cell.style.background = color;
    positionCell();
  };
  const setBaseline = (nextMode, value) => {
    cleanup();
    armed = null;
    last = null;
    cadence = false;
    mode = nextMode;
    paint(value);
    return true;
  };
  const arm = (kind, token, expected, expectedPoint) => {
    cleanup();
    armed = { kind, token, expected };
    last = null;
    const eventName = kind === "key" ? "keydown" : "mousemove";
    const handler = (event) => {
      if (!armed || armed.kind !== kind) return;
      if (kind === "key" && (event.key !== "a" || event.repeat || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) return;
      if (kind === "pointer" && (!expectedPoint || Math.abs(event.screenX - expectedPoint.x) > 2 || Math.abs(event.screenY - expectedPoint.y) > 2)) return;
      const accepted = armed;
      armed = null;
      last = { kind, token: accepted.token, at: performance.now() };
      paint(accepted.expected);
      cleanup();
      event.preventDefault();
    };
    window.addEventListener(eventName, handler, { capture: true });
    cleanup = () => window.removeEventListener(eventName, handler, { capture: true });
    return true;
  };
  const cadenceFrame = () => {
    if (!cadence) return;
    paint(Math.floor(performance.now() / 16) % 2 === 0 ? ${DARK_VALUE} : ${LIGHT_VALUE});
    requestAnimationFrame(cadenceFrame);
  };
  const startCadence = (nextMode) => {
    cleanup();
    armed = null;
    mode = nextMode;
    cadence = true;
    requestAnimationFrame(cadenceFrame);
  };
  const stopCadence = () => { cadence = false; };
  const state = () => ({
    ready: true,
    focused: document.hasFocus(),
    visible: document.visibilityState === "visible",
    armed,
    last,
  });
  window.__agentbrowseLatencyProbe = { setBaseline, arm, startCadence, stopCadence, state };
  window.addEventListener("resize", positionCell);
  window.addEventListener("mousedown", () => document.body.focus(), { capture: true });
  document.body.focus();
  setBaseline("viewport", ${DARK_VALUE});
})();
</script>`;

if (import.meta.main) {
  let options: ProbeOptions;
  try {
    options = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    if (error instanceof ProbeUsageError && !error.message.startsWith("Usage:")) {
      process.stderr.write(usage());
    }
    process.exit(2);
  }
  try {
    const report = await main(options);
    process.stdout.write(options.json ? `${JSON.stringify(report)}\n` : humanReport(report));
  } catch (error) {
    process.stderr.write(
      `live-view-latency: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
