#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { release as osRelease } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CliRenderer } from "@opentui/core";

import { listBrowserTargets } from "../client/targets.ts";
import {
  LiveViewRenderable,
  type LiveViewSubmissionMetrics,
} from "../src/opentui/LiveViewRenderable.ts";
import { defaultNativeLibraryPath } from "../src/opentui/native.ts";

const SCHEMA_VERSION = 1;
const EVENT_LOOP_INTERVAL_MS = 5;
const READY_TIMEOUT_MS = 20_000;

export interface AdapterProbeOptions {
  target: string;
  seconds: number;
  warmupSeconds: number;
  pollFps: number;
  rendererFps: number;
  scenario: string;
  jsonPath: string;
}

export interface Distribution {
  count: number;
  min: number;
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

class AdapterUsageError extends Error {}

class AdapterMonitor {
  readonly eventLoopGapsMs: number[] = [];
  readonly submissionIntervalsMs: number[] = [];
  readonly submissionAgesMs: number[] = [];
  readonly conversionMs: number[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private previousTick = 0;
  private previousSubmission: number | null = null;
  private active = false;

  start(surface: LiveViewRenderable): void {
    this.active = true;
    this.previousTick = performance.now();
    this.timer = setInterval(() => {
      const now = performance.now();
      this.eventLoopGapsMs.push(Math.max(0, now - this.previousTick - EVENT_LOOP_INTERVAL_MS));
      this.previousTick = now;
      const age = surface.submissionMetrics(now).submissionAgeMs;
      if (age !== null) this.submissionAgesMs.push(age);
    }, EVENT_LOOP_INTERVAL_MS);
  }

  onSubmission(metrics: LiveViewSubmissionMetrics): void {
    if (!this.active) return;
    const now = performance.now();
    if (this.previousSubmission !== null) {
      this.submissionIntervalsMs.push(now - this.previousSubmission);
    }
    this.previousSubmission = now;
    this.conversionMs.push(metrics.lastConversionMs);
  }

  stop(): void {
    this.active = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

export function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) throw new RangeError("percentile requires at least one value");
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  const fraction = position - lower;
  return sorted[lower]! * (1 - fraction) + sorted[upper]! * fraction;
}

export function summarize(values: readonly number[]): Distribution | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    min: sorted[0]!,
    mean: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1]!,
  };
}

export function parseAdapterProbeArgs(argv: readonly string[]): AdapterProbeOptions {
  if (argv.includes("--help") || argv.includes("-h")) throw new AdapterUsageError(usage());
  const target = argv[0];
  if (!target || target.startsWith("-"))
    throw new AdapterUsageError("a Browser target name is required");
  const options: AdapterProbeOptions = {
    target,
    seconds: 10,
    warmupSeconds: 3,
    pollFps: 30,
    rendererFps: 30,
    scenario: "current",
    jsonPath: resolve("zig-out/live-view-adapter.json"),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new AdapterUsageError(`${flag} requires a value`);
      index += 1;
      return value;
    };
    switch (flag) {
      case "--seconds":
        options.seconds = integer(next(), flag, 1, 300);
        break;
      case "--warmup-seconds":
        options.warmupSeconds = integer(next(), flag, 0, 60);
        break;
      case "--poll-fps":
        options.pollFps = integer(next(), flag, 1, 30);
        break;
      case "--renderer-fps":
        options.rendererFps = integer(next(), flag, 1, 60);
        break;
      case "--scenario":
        options.scenario = label(next(), flag);
        break;
      case "--json":
        options.jsonPath = resolve(next());
        break;
      default:
        throw new AdapterUsageError(`unknown option: ${flag}`);
    }
  }
  return options;
}

async function run(options: AdapterProbeOptions): Promise<Record<string, unknown>> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("the adapter probe must run in a real terminal");
  }
  const target = (await listBrowserTargets()).find(
    (candidate) => candidate.name === options.target,
  );
  if (!target) throw new Error(`unknown Browser target: ${options.target}`);
  if (!target.selectable) {
    throw new Error(
      `Browser target ${target.name} is unavailable${target.disabledReason ? `: ${target.disabledReason}` : ""}`,
    );
  }

  const monitor = new AdapterMonitor();
  const renderer = new CliRenderer(
    process.stdin,
    process.stdout,
    process.stdout.columns || 80,
    process.stdout.rows || 24,
    {
      exitOnCtrlC: false,
      targetFps: options.rendererFps,
      maxFps: options.rendererFps,
      useKittyKeyboard: {
        disambiguate: true,
        alternateKeys: true,
        events: true,
        allKeysAsEscapes: true,
        reportText: true,
      },
    },
  );
  const surface = new LiveViewRenderable(renderer, {
    id: "agentbrowse-live-view-adapter-probe",
    width: "100%",
    height: "100%",
    visible: true,
    pollFps: options.pollFps,
    onSubmission: (metrics) => monitor.onSubmission(metrics),
  });
  renderer.root.add(surface);

  try {
    await renderer.setupTerminal();
    renderer.start();
    await surface.connect(target);
    surface.focus();
    await waitForFirstSubmission(surface);
    if (options.warmupSeconds > 0) await Bun.sleep(options.warmupSeconds * 1_000);

    const submissionStart = surface.submissionMetrics();
    const nativeStart = surface.nativeMetrics();
    const measuredStartedAt = performance.now();
    monitor.start(surface);
    await Bun.sleep(options.seconds * 1_000);
    monitor.stop();
    const measuredEndedAt = performance.now();
    const submissionEnd = surface.submissionMetrics(measuredEndedAt);
    const nativeEnd = surface.nativeMetrics();
    const snapshot = surface.nativeSnapshot();
    const durationMs = measuredEndedAt - measuredStartedAt;

    return {
      schemaVersion: SCHEMA_VERSION,
      scenario: options.scenario,
      target: {
        name: target.name,
        backend: target.backend,
        slot: target.slot,
      },
      parameters: {
        durationMs,
        warmupSeconds: options.warmupSeconds,
        pollFps: options.pollFps,
        rendererFps: options.rendererFps,
        eventLoopIntervalMs: EVENT_LOOP_INTERVAL_MS,
      },
      terminal: {
        columns: process.stdout.columns,
        rows: process.stdout.rows,
        term: process.env.TERM ?? null,
        program: process.env.TERM_PROGRAM ?? null,
        programVersion: process.env.TERM_PROGRAM_VERSION ?? null,
      },
      submission: {
        submittedFrames: submissionEnd.submittedFrames - submissionStart.submittedFrames,
        skippedFrames: submissionEnd.skippedFrames - submissionStart.skippedFrames,
        rgbaBytes: submissionEnd.rgbaBytes - submissionStart.rgbaBytes,
        rgbaBytesPerSecond:
          (Number(submissionEnd.rgbaBytes - submissionStart.rgbaBytes) * 1_000) / durationMs,
        generationDelta: submissionEnd.latestGeneration - submissionStart.latestGeneration,
        outputWidth: submissionEnd.outputWidth,
        outputHeight: submissionEnd.outputHeight,
        conversionMs: summarize(monitor.conversionMs),
        intervalMs: summarize(monitor.submissionIntervalsMs),
        ageMs: summarize(monitor.submissionAgesMs),
      },
      eventLoopGapMs: summarize(monitor.eventLoopGapsMs),
      native: { start: nativeStart, end: nativeEnd, snapshot },
      provenance: await buildProvenance(),
    };
  } finally {
    monitor.stop();
    try {
      await surface.dispose();
    } finally {
      renderer.destroy();
    }
  }
}

async function waitForFirstSubmission(surface: LiveViewRenderable): Promise<void> {
  const deadline = performance.now() + READY_TIMEOUT_MS;
  while (performance.now() < deadline) {
    if (surface.submissionMetrics().submittedFrames > 0n) return;
    const state = surface.state();
    if (state.phase === "failed") throw new Error(state.error ?? state.status);
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting ${READY_TIMEOUT_MS} ms for the first adapter frame`);
}

async function buildProvenance(): Promise<Record<string, unknown>> {
  const nativeLibraryPath = defaultNativeLibraryPath();
  const nativeStat = await stat(nativeLibraryPath);
  const assetRoot = process.env.OTUI_ASSET_ROOT?.trim() || null;
  const packageName = `@opentui/core-${process.platform}-${process.arch}${
    process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : ""
  }`;
  const packagePath = fileURLToPath(import.meta.resolve(`${packageName}/package.json`));
  const packageMetadata = JSON.parse(await readFile(packagePath, "utf8")) as {
    version?: string;
  };
  const assetPath = assetRoot
    ? openTuiAssetPath(assetRoot)
    : join(dirname(packagePath), openTuiLibraryFileName());
  const assetStat = await stat(assetPath);
  const openTuiAsset: Record<string, unknown> = {
    override: assetRoot !== null,
    root: assetRoot ? resolve(assetRoot) : dirname(packagePath),
    path: assetPath,
    bytes: assetStat.size,
    sha256: await sha256File(assetPath),
    packageVersion: packageMetadata.version ?? null,
  };
  let comparison: unknown = null;
  if (assetRoot) {
    comparison = await readJson(join(assetRoot, "..", "comparison.json"));
  }
  const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "..") });
  const status = Bun.spawnSync(["git", "status", "--porcelain"], {
    cwd: join(import.meta.dir, ".."),
  });
  return {
    nativeLibraryPath,
    nativeLibraryBytes: nativeStat.size,
    nativeComparison: await readJson(join(dirname(dirname(nativeLibraryPath)), "comparison.json")),
    openTuiAsset,
    openTuiComparison: comparison,
    sourceCommit: head.exitCode === 0 ? head.stdout.toString().trim() : null,
    sourceDirty: status.exitCode === 0 ? status.stdout.byteLength > 0 : null,
    runtime: {
      bunVersion: Bun.version,
      platform: process.platform,
      architecture: process.arch,
      osRelease: osRelease(),
    },
  };
}

export function openTuiAssetPath(assetRoot: string): string {
  const libcSuffix =
    process.platform === "linux" && process.env.OPENTUI_LIBC === "musl" ? "-musl" : "";
  return join(
    assetRoot,
    `@opentui/core-${process.platform}-${process.arch}${libcSuffix}`,
    openTuiLibraryFileName(),
  );
}

function openTuiLibraryFileName(): string {
  return process.platform === "darwin"
    ? "libopentui.dylib"
    : process.platform === "win32"
      ? "opentui.dll"
      : "libopentui.so";
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function integer(value: string, flag: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new AdapterUsageError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AdapterUsageError(`${flag} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function label(value: string, flag: string): string {
  if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value)) {
    throw new AdapterUsageError(`${flag} must be a short lowercase label`);
  }
  return value;
}

function usage(): string {
  return `Usage: bun run tools/live-view-adapter.ts NAME [options]

Options:
  --seconds N          Measured adapter duration (default 10)
  --warmup-seconds N   Warmup after the first submitted frame (default 3)
  --poll-fps N         Live View polling rate, 1-30 (default 30)
  --renderer-fps N     OpenTUI renderer rate, 1-60 (default 30)
  --scenario LABEL     Comparison label (default current)
  --json PATH          JSON report path (default zig-out/live-view-adapter.json)
`;
}

function stringifyReport(report: Record<string, unknown>): string {
  return `${JSON.stringify(report, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
}

function formatDistribution(value: Distribution | null): string {
  if (!value) return "no samples";
  return `p50 ${value.p50.toFixed(2)} ms, p95 ${value.p95.toFixed(2)} ms, max ${value.max.toFixed(2)} ms`;
}

async function main(): Promise<void> {
  let options: AdapterProbeOptions;
  try {
    options = parseAdapterProbeArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof AdapterUsageError) {
      const message = error.message;
      process.stderr.write(message.startsWith("Usage:") ? message : `${message}\n${usage()}`);
      process.exitCode = message.startsWith("Usage:") ? 0 : 2;
      return;
    }
    throw error;
  }
  const report = await run(options);
  await mkdir(dirname(options.jsonPath), { recursive: true });
  await writeFile(options.jsonPath, stringifyReport(report), { mode: 0o600 });
  const submission = report.submission as {
    submittedFrames: bigint;
    skippedFrames: bigint;
    conversionMs: Distribution | null;
    ageMs: Distribution | null;
  };
  process.stdout.write(
    [
      `Adapter probe: ${options.target} (${options.scenario})`,
      `Frames: ${submission.submittedFrames} submitted, ${submission.skippedFrames} skipped`,
      `Conversion: ${formatDistribution(submission.conversionMs)}`,
      `Submission age: ${formatDistribution(submission.ageMs)}`,
      `Event-loop gaps: ${formatDistribution(report.eventLoopGapMs as Distribution | null)}`,
      `Report: ${options.jsonPath}`,
      "",
    ].join("\n"),
  );
}

if (import.meta.main) {
  await main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
