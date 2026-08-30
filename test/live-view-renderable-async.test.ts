import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { CliRenderer } from "@opentui/core";

import type {
  AsyncConvertibleFrameLease,
  FrameConversionResult,
} from "../src/opentui/AsyncFrameConverter.ts";
import { LiveViewRenderable } from "../src/opentui/LiveViewRenderable.ts";
import type { NativeFrameInfo } from "../src/opentui/native.ts";

test("busy poll ticks do not acquire frames or advance the submitted generation", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession(new FakeLease(frameInfo(7n)));
    harness.internals.session = session;
    harness.internals.activeConversion = Promise.resolve();

    harness.internals.pollNative();

    expect(session.acquireCalls).toEqual([]);
    expect(harness.surface.submissionMetrics()).toMatchObject({
      latestGeneration: 0n,
      busySkips: 1n,
      submittedFrames: 0n,
    });
    harness.internals.activeConversion = null;
  } finally {
    await harness.dispose();
  }
});

test("a fit change during conversion drops the stale completion without advancing generation", async () => {
  const harness = await renderableHarness();
  try {
    const lease = new FakeLease(frameInfo(3n));
    const session = new FakeSession(lease);
    harness.internals.session = session;

    harness.internals.pollNative();
    expect(session.acquireCalls).toEqual([0n]);
    expect(harness.surface.submissionMetrics().latestGeneration).toBe(0n);
    expect(harness.converter.requests).toHaveLength(1);

    harness.internals._widthValue = 2;
    harness.converter.finishNext();
    await harness.internals.activeConversion;

    expect(lease.closes).toBe(1);
    expect(harness.surface.submissionMetrics()).toMatchObject({
      latestGeneration: 0n,
      submittedFrames: 0n,
      staleConversions: 1n,
    });
  } finally {
    await harness.dispose();
  }
});

test("session close during conversion waits for lease release and drops completion", async () => {
  const harness = await renderableHarness();
  try {
    const lease = new FakeLease(frameInfo(11n));
    const session = new FakeSession(lease);
    harness.internals.session = session;
    harness.internals.pollNative();

    const disconnecting = harness.surface.disconnect();
    await Promise.resolve();
    expect(session.closed).toBe(true);
    expect(lease.closes).toBe(0);

    harness.converter.finishNext();
    await disconnecting;
    expect(lease.closes).toBe(1);
    expect(session.callsAfterClose).toBe(0);
    expect(harness.surface.submissionMetrics()).toMatchObject({
      latestGeneration: 0n,
      submittedFrames: 0n,
    });
  } finally {
    await harness.dispose();
  }
});

test("completion submits immediately and reuses shared bytes only after NativeImage copies", async () => {
  const harness = await renderableHarness();
  try {
    const firstLease = new FakeLease(frameInfo(1n));
    const secondLease = new FakeLease(frameInfo(3n));
    harness.internals.session = new FakeSession([firstLease, secondLease]);

    harness.internals.pollNative();
    const firstTask = harness.internals.activeConversion;
    const firstBytes = harness.converter.finishNext();
    await firstTask;
    expect(harness.surface.submissionMetrics()).toMatchObject({
      latestGeneration: 1n,
      submittedFrames: 1n,
      skippedFrames: 0n,
    });

    harness.internals.pollNative();
    expect(harness.converter.requests[0]?.reusable).toBe(firstBytes);
    const secondTask = harness.internals.activeConversion;
    harness.converter.finishNext();
    await secondTask;
    expect(harness.surface.submissionMetrics()).toMatchObject({
      latestGeneration: 3n,
      submittedFrames: 2n,
      skippedFrames: 1n,
    });
    expect(firstLease.closes).toBe(1);
    expect(secondLease.closes).toBe(1);
  } finally {
    await harness.dispose();
  }
});

test("a native conversion result failure marks the current surface failed", async () => {
  const harness = await renderableHarness();
  try {
    const lease = new FakeLease(frameInfo(5n));
    const session = new FakeSession(lease);
    harness.internals.session = session;
    harness.internals.pollNative();
    const conversion = harness.internals.activeConversion;

    harness.converter.failNext(
      new Error("native Live View frame conversion failed: internal error"),
    );
    await conversion;

    expect(lease.closes).toBe(1);
    expect(session.releasedHeldInput).toBe(1);
    expect(harness.surface.state()).toMatchObject({
      phase: "failed",
      error: "native Live View frame conversion failed: internal error",
    });
  } finally {
    await harness.dispose();
  }
});

interface RenderableInternals {
  session: FakeSession | null;
  activeConversion: Promise<void> | null;
  _widthValue: number;
  pollNative(): void;
  frameConverter: FakeConversionClient;
}

async function renderableHarness(): Promise<{
  renderer: CliRenderer;
  surface: LiveViewRenderable;
  internals: RenderableInternals;
  converter: FakeConversionClient;
  dispose(): Promise<void>;
}> {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const renderer = new CliRenderer(stdin, stdout, 80, 24, {
    exitOnCtrlC: false,
  });
  const surface = new LiveViewRenderable(renderer, {
    width: 10,
    height: 10,
    visible: true,
    conversionMode: "synchronous",
  });
  const internals = surface as unknown as RenderableInternals;
  const original = internals.frameConverter as unknown as { close(): Promise<void> };
  await original.close();
  const converter = new FakeConversionClient();
  internals.frameConverter = converter;
  return {
    renderer,
    surface,
    internals,
    converter,
    async dispose() {
      try {
        await surface.dispose();
      } finally {
        renderer.destroy();
      }
    },
  };
}

class FakeConversionClient {
  readonly requests: Array<{
    lease: AsyncConvertibleFrameLease;
    width: number;
    height: number;
    reusable: Uint8Array | undefined;
    resolve: (result: FrameConversionResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  closed = false;

  convert(
    lease: AsyncConvertibleFrameLease,
    width: number,
    height: number,
    reusable?: Uint8Array,
  ): Promise<FrameConversionResult> {
    return new Promise((resolve, reject) => {
      this.requests.push({ lease, width, height, reusable, resolve, reject });
    });
  }

  finishNext(): Uint8Array {
    const request = this.requests.shift();
    if (!request) throw new Error("no pending conversion");
    const byteLength = request.width * request.height * 4;
    const bytes =
      request.reusable?.byteLength === byteLength
        ? request.reusable
        : new Uint8Array(new SharedArrayBuffer(byteLength));
    request.lease.close();
    request.resolve({ bytes, conversionMs: 1, roundTripMs: 2, mode: "worker" });
    return bytes;
  }

  failNext(error: unknown): void {
    const request = this.requests.shift();
    if (!request) throw new Error("no pending conversion");
    request.lease.close();
    request.reject(error);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeSession {
  readonly acquireCalls: bigint[] = [];
  closed = false;
  callsAfterClose = 0;
  releasedHeldInput = 0;
  private readonly leases: FakeLease[];

  constructor(lease: FakeLease | FakeLease[]) {
    this.leases = Array.isArray(lease) ? [...lease] : [lease];
  }

  snapshot() {
    this.assertOpen();
    return {
      lifecycle: "connected" as const,
      dataOpen: true,
      authorized: true,
      controlRequested: false,
      readOnly: false,
      closed: false,
      remoteWidth: 8,
      remoteHeight: 4,
      latestFrameGeneration: this.leases.at(-1)?.info().generation ?? 0n,
    };
  }

  status(): string {
    this.assertOpen();
    return "Connected";
  }

  acquireFrame(afterGeneration: bigint): FakeLease | null {
    this.assertOpen();
    this.acquireCalls.push(afterGeneration);
    return this.leases.shift() ?? null;
  }

  releaseHeldInput(): void {
    if (this.closed) this.callsAfterClose += 1;
    this.releasedHeldInput += 1;
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (!this.closed) return;
    this.callsAfterClose += 1;
    throw new Error("fake session used after close");
  }
}

class FakeLease implements AsyncConvertibleFrameLease {
  closes = 0;

  constructor(private readonly frame: NativeFrameInfo) {}

  info(): NativeFrameInfo {
    return this.frame;
  }

  convertRgba(): Uint8Array {
    throw new Error("fake lease conversion should be owned by the fake converter");
  }

  workerRgbaOutput(): never {
    throw new Error("fake lease conversion should be owned by the fake converter");
  }

  transfer(): never {
    throw new Error("fake lease conversion should be owned by the fake converter");
  }

  close(): void {
    this.closes += 1;
  }
}

function frameInfo(generation: bigint): NativeFrameInfo {
  return {
    format: "i420",
    width: 8,
    height: 4,
    displayWidth: 8,
    displayHeight: 4,
    rotationDegrees: 0,
    generation,
    timestampUs: generation * 1_000n,
  };
}
