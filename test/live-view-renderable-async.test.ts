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

test("Kitty shortcut release restores the physical modifiers after Command was released first", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    expect(
      harness.internals.forwardKey(keyEvent({ name: "c", baseCode: 99, super: true, shift: true })),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0xffe1n, pressed: true, repeat: false },
      { keysym: 0xffe3n, pressed: true, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0x43n, pressed: true, repeat: false },
    ]);

    harness.internals.forwardKey(
      keyEvent({ name: "leftsuper", super: false, eventType: "release" }),
    );
    expect(session.keyCalls.slice(-5)).toContainEqual({
      keysym: 0xffe3n,
      pressed: false,
      repeat: false,
    });

    expect(
      harness.internals.forwardKey(
        keyEvent({
          name: "c",
          baseCode: 99,
          super: false,
          shift: true,
          eventType: "release",
        }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(-6)).toEqual([
      { keysym: 0x43n, pressed: false, repeat: false },
      { keysym: 0xffe1n, pressed: true, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
    ]);
  } finally {
    await harness.dispose();
  }
});

test("a Kitty Command-[ press forwards Alt before Left and its release restores Meta", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    expect(harness.internals.forwardKey(keyEvent({ name: "[", baseCode: 91, super: true }))).toBe(
      true,
    );
    expect(session.keyCalls).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: true, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0xff51n, pressed: true, repeat: false },
    ]);

    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "[", baseCode: 91, super: true, eventType: "release" }),
      ),
    ).toBe(true);
    expect(session.keyCalls).toEqual([
      { keysym: 0xff51n, pressed: false, repeat: false },
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: true, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
    ]);
    expect(harness.internals.activeKeys.size).toBe(0);
  } finally {
    await harness.dispose();
  }
});

test("a Kitty Command-Shift-] press withholds Shift and forwards Control-Page_Down", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    expect(
      harness.internals.forwardKey(keyEvent({ name: "]", baseCode: 93, super: true, shift: true })),
    ).toBe(true);
    expect(session.keyCalls).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: true, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0xff56n, pressed: true, repeat: false },
    ]);

    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "]", baseCode: 93, super: true, shift: true, eventType: "release" }),
      ),
    ).toBe(true);
    expect(session.keyCalls).toEqual([
      { keysym: 0xff56n, pressed: false, repeat: false },
      { keysym: 0xffe1n, pressed: true, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: true, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
    ]);
    expect(harness.internals.activeKeys.size).toBe(0);
  } finally {
    await harness.dispose();
  }
});

test("raw Option navigation remains a tap and clears translated modifiers", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "left", source: "raw", meta: true, option: false }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 7)).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: true, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0xff51n, pressed: true, repeat: false },
      { keysym: 0xff51n, pressed: false, repeat: false },
    ]);
    expect(session.keyCalls.slice(-5).every((call) => call.pressed === false)).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("releaseHeldInput clears translated Kitty state and leaves Command-V local", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    expect(harness.internals.forwardKey(keyEvent({ name: "c", baseCode: 99, super: true }))).toBe(
      true,
    );
    session.keyCalls.length = 0;

    harness.surface.releaseHeldInput();
    expect(session.releasedHeldInput).toBe(1);
    expect(
      harness.internals.forwardKey(
        keyEvent({
          name: "c",
          baseCode: 99,
          super: false,
          eventType: "release",
        }),
      ),
    ).toBe(true);
    expect(session.keyCalls.some((call) => call.keysym === 0xffe3n && call.pressed)).toBe(false);

    session.keyCalls.length = 0;
    expect(harness.internals.forwardKey(keyEvent({ name: "v", baseCode: 118, super: true }))).toBe(
      false,
    );
    expect(session.keyCalls).toEqual([]);
  } finally {
    await harness.dispose();
  }
});

test("an observed control loss clears translated Kitty state", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    harness.internals.pollNative();
    expect(harness.internals.forwardKey(keyEvent({ name: "c", baseCode: 99, super: true }))).toBe(
      true,
    );

    session.authorized = false;
    harness.internals.pollNative();
    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({
          name: "c",
          baseCode: 99,
          super: false,
          eventType: "release",
        }),
      ),
    ).toBe(true);
    expect(session.keyCalls.some((call) => call.keysym === 0xffe3n && call.pressed)).toBe(false);
  } finally {
    await harness.dispose();
  }
});

test("an active translated key does not transform an unrelated Kitty key", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    expect(harness.internals.forwardKey(keyEvent({ name: "c", baseCode: 99, super: true }))).toBe(
      true,
    );
    session.keyCalls.length = 0;

    expect(harness.internals.forwardKey(keyEvent({ name: "b", baseCode: 98, super: true }))).toBe(
      true,
    );
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: true, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0x62n, pressed: true, repeat: false },
    ]);
  } finally {
    await harness.dispose();
  }
});

test("an identity-less repeat replaces the prior same-name Kitty target", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    harness.internals.forwardKey(keyEvent({ name: "c", baseCode: 99, super: true }));
    expect([...harness.internals.activeKeys.keys()]).toEqual(["base:99"]);

    // Native duplicate suppression rejects the repeated key-down. The JS
    // identity still has to migrate so a release without Kitty alternates can
    // find and clear the target.
    session.acceptKeys = false;
    harness.internals.forwardKey(
      keyEvent({ name: "c", super: true, eventType: "repeat", repeated: true }),
    );
    expect([...harness.internals.activeKeys.keys()]).toEqual(["name:c"]);
  } finally {
    await harness.dispose();
  }
});

test("shifted Kitty targets survive modifier-first release and missing release alternates", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "z", sequence: "Z", baseCode: 122, shift: true }),
      ),
    ).toBe(true);
    expect(session.keyCalls.at(-1)).toEqual({
      keysym: 0x5an,
      pressed: true,
      repeat: false,
    });

    harness.internals.forwardKey(
      keyEvent({ name: "leftshift", shift: false, eventType: "release" }),
    );
    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({
          name: "z",
          sequence: "z",
          shift: false,
          eventType: "release",
        }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0x5an, pressed: false, repeat: false },
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
    ]);
    expect(session.keyCalls.slice(-5).every((call) => call.pressed === false)).toBe(true);
  } finally {
    await harness.dispose();
  }
});

test("Caps Lock text selects the guest XKB level without changing shortcut meaning", async () => {
  const harness = await renderableHarness();
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "c", sequence: "C", capsLock: true, shift: false }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0xffe1n, pressed: true, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0x43n, pressed: true, repeat: false },
    ]);
    harness.internals.forwardKey(
      keyEvent({
        name: "c",
        sequence: "C",
        capsLock: true,
        eventType: "release",
      }),
    );

    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "C", baseCode: 99, capsLock: true, super: true }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: true, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0x63n, pressed: true, repeat: false },
    ]);
    harness.internals.forwardKey(
      keyEvent({
        name: "C",
        baseCode: 99,
        capsLock: true,
        super: false,
        eventType: "release",
      }),
    );

    session.keyCalls.length = 0;
    expect(
      harness.internals.forwardKey(
        keyEvent({ name: "z", sequence: "z", capsLock: true, shift: true }),
      ),
    ).toBe(true);
    expect(session.keyCalls.slice(0, 6)).toEqual([
      { keysym: 0xffe1n, pressed: false, repeat: false },
      { keysym: 0xffe3n, pressed: false, repeat: false },
      { keysym: 0xffe9n, pressed: false, repeat: false },
      { keysym: 0xffe7n, pressed: false, repeat: false },
      { keysym: 0xffedn, pressed: false, repeat: false },
      { keysym: 0x7an, pressed: true, repeat: false },
    ]);
  } finally {
    await harness.dispose();
  }
});

interface RenderableInternals {
  session: FakeSession | null;
  activeKeys: Map<string, unknown>;
  activeConversion: Promise<void> | null;
  _widthValue: number;
  pollNative(): void;
  frameConverter: FakeConversionClient;
  forwardKey(key: ReturnType<typeof keyEvent>): boolean;
}

test("a new guest clipboard observation is mirrored to the terminal exactly once", async () => {
  const harness = await renderableHarness();
  const copies: string[] = [];
  (
    harness.renderer as unknown as { copyToClipboardOSC52(text: string): boolean }
  ).copyToClipboardOSC52 = (text: string) => {
    copies.push(text);
    return true;
  };
  try {
    const session = new FakeSession();
    harness.internals.session = session;

    // Generation zero is the untouched observation: nothing has been copied in
    // the guest, so the operator's own clipboard is left alone.
    harness.internals.pollNative();
    expect(copies).toEqual([]);

    session.clipboardTextValue = "copied in the guest";
    session.clipboardGeneration = 1n;
    harness.internals.pollNative();
    expect(copies).toEqual(["copied in the guest"]);

    // The observation is latest-value, so repeated polls at the same generation
    // must not rewrite the terminal clipboard.
    harness.internals.pollNative();
    expect(copies).toEqual(["copied in the guest"]);
  } finally {
    await harness.dispose();
  }
});

test("an oversized guest clipboard is skipped rather than copied in part", async () => {
  const harness = await renderableHarness();
  const copies: string[] = [];
  (
    harness.renderer as unknown as { copyToClipboardOSC52(text: string): boolean }
  ).copyToClipboardOSC52 = (text: string) => {
    copies.push(text);
    return true;
  };
  try {
    const session = new FakeSession();
    harness.internals.session = session;
    session.clipboardTextValue = "x".repeat(64 * 1024 + 1);
    session.clipboardGeneration = 1n;

    harness.internals.pollNative();
    expect(copies).toEqual([]);

    // The skipped generation is genuinely claimed: re-offering a presentable
    // text at that SAME generation must stay skipped, or the claim is doing
    // nothing and a stuck oversize observation would retry every tick.
    session.clipboardTextValue = "now presentable";
    harness.internals.pollNative();
    expect(copies).toEqual([]);

    // A later observation is a new generation and is not blocked behind it.
    session.clipboardTextValue = "small enough";
    session.clipboardGeneration = 2n;
    harness.internals.pollNative();
    expect(copies).toEqual(["small enough"]);
  } finally {
    await harness.dispose();
  }
});

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
  const original = internals.frameConverter as unknown as {
    close(): Promise<void>;
  };
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
  dataOpen = true;
  authorized = true;
  acceptKeys = true;
  clipboardGeneration = 0n;
  clipboardTextValue: string | null = null;
  readonly keyCalls: Array<{
    keysym: bigint;
    pressed: boolean;
    repeat: boolean;
  }> = [];
  private readonly leases: FakeLease[];

  constructor(lease: FakeLease | FakeLease[] = []) {
    this.leases = Array.isArray(lease) ? [...lease] : [lease];
  }

  snapshot() {
    this.assertOpen();
    return {
      lifecycle: "connected" as const,
      dataOpen: this.dataOpen,
      authorized: this.authorized,
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

  clipboardSnapshot() {
    this.assertOpen();
    const text = this.clipboardTextValue;
    return {
      textAvailable: text !== null,
      textByteLength: text === null ? 0 : Buffer.byteLength(text, "utf8"),
      generation: this.clipboardGeneration,
    };
  }

  clipboardText(): string | null {
    this.assertOpen();
    return this.clipboardTextValue;
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

  setKey(keysym: bigint, pressed: boolean, repeat = false): boolean {
    this.assertOpen();
    this.keyCalls.push({ keysym, pressed, repeat });
    return this.acceptKeys;
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

function keyEvent(
  overrides: Partial<{
    name: string;
    sequence: string;
    baseCode: number;
    code: string;
    super: boolean;
    option: boolean;
    meta: boolean;
    ctrl: boolean;
    shift: boolean;
    capsLock: boolean;
    hyper: boolean;
    eventType: "press" | "repeat" | "release";
    source: "raw" | "kitty";
    repeated: boolean;
  }> = {},
) {
  return {
    name: "a",
    super: false,
    option: false,
    meta: false,
    ctrl: false,
    shift: false,
    capsLock: false,
    hyper: false,
    eventType: "press" as const,
    source: "kitty" as const,
    repeated: false,
    ...overrides,
  };
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
