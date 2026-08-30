import type { Pointer } from "bun:ffi";
import { expect, test } from "bun:test";

import {
  type AsyncConvertibleFrameLease,
  AsyncFrameConverterPool,
  AsyncFrameConverterUnavailableError,
  type FrameLeaseTransfer,
} from "../src/opentui/AsyncFrameConverter.ts";
import {
  type FrameConversionWorkerMessage,
  type FrameConversionWorkerRequest,
  type FrameConversionWorkerResponse,
  LEASE_RELEASED,
} from "../src/opentui/frame-conversion-protocol.ts";

test("the shared converter serializes clients and transfers each lease exactly once", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const firstClient = pool.createClient("/native/test.dylib");
  const secondClient = pool.createClient("/native/test.dylib");
  const firstLease = new FakeLease();
  const secondLease = new FakeLease();

  const first = firstClient.convert(firstLease, 4, 3);
  const second = secondClient.convert(secondLease, 4, 3);
  expect(worker.messages.map((message) => message.type)).toEqual(["initialize"]);

  worker.finishInitialization();
  expect(worker.conversions()).toHaveLength(1);
  worker.finishConversion(0, 1.25);
  expect((await first).mode).toBe("worker");
  expect(worker.conversions()).toHaveLength(2);
  worker.finishConversion(1, 1.5);
  expect((await second).mode).toBe("worker");

  expect(firstLease).toMatchObject({ transfers: 1, releases: 0, acknowledgements: 1, closes: 0 });
  expect(secondLease).toMatchObject({ transfers: 1, releases: 0, acknowledgements: 1, closes: 0 });

  const firstClose = firstClient.close();
  await expect(secondClient.close()).resolves.toBeUndefined();
  await expect(firstClose).resolves.toBeUndefined();
  expect(worker.messages.at(-1)?.type).toBe("shutdown");
  expect(worker.terminated).toBe(true);
});

test("one renderable client cannot queue a second lease while its first is busy", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const firstLease = new FakeLease();
  const rejectedLease = new FakeLease();
  const first = client.convert(firstLease, 2, 2);

  await expect(client.convert(rejectedLease, 2, 2)).rejects.toThrow(
    "already has a conversion in flight",
  );
  expect(rejectedLease.closes).toBe(1);

  worker.finishInitialization();
  worker.finishConversion(0, 0.5);
  await first;
  await client.close();
});

test("a dylib probe failure keeps lease ownership on main and converts synchronously", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const lease = new FakeLease();
  const result = client.convert(lease, 3, 2);

  worker.finishInitialization("dlopen failed");
  expect(await result).toMatchObject({ mode: "synchronous-fallback" });
  expect(lease).toMatchObject({ synchronousConversions: 1, transfers: 0, closes: 1 });
  await client.close();
});

test("a per-frame output error rejects only that job and keeps the worker available", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const invalid = client.convert(new InvalidOutputLease(), 4, 3);
  worker.finishInitialization();
  await expect(invalid).rejects.toBeInstanceOf(RangeError);

  const valid = client.convert(new FakeLease(), 4, 3);
  expect(worker.conversions()).toHaveLength(1);
  worker.finishConversion(0, 0.5);
  expect((await valid).mode).toBe("worker");
  await client.close();
});

test("worker startup failure falls back on the same frame", async () => {
  const pool = new AsyncFrameConverterPool(() => {
    throw new Error("worker script missing");
  });
  const client = pool.createClient("/native/test.dylib");
  const lease = new FakeLease();

  const result = await client.convert(lease, 3, 2);
  expect(result.mode).toBe("synchronous-fallback");
  expect(lease).toMatchObject({ synchronousConversions: 1, transfers: 0, closes: 1 });
  await client.close();
});

test("the real Bun worker entrypoint probes before accepting a lease", async () => {
  const pool = new AsyncFrameConverterPool();
  const client = pool.createClient("/agentbrowse-test/missing-live-view.dylib");
  const lease = new FakeLease();

  const result = await client.convert(lease, 2, 2);
  expect(result.mode).toBe("synchronous-fallback");
  expect(lease).toMatchObject({ synchronousConversions: 1, transfers: 0, closes: 1 });
  await client.close();
});

test("worker death backstops the transferred lease and future frames use fallback", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const abandonedLease = new FakeLease();
  const abandoned = client.convert(abandonedLease, 4, 3);
  worker.finishInitialization();
  expect(worker.conversions()).toHaveLength(1);

  worker.crash(9);
  await expect(abandoned).rejects.toBeInstanceOf(AsyncFrameConverterUnavailableError);
  expect(abandonedLease).toMatchObject({ transfers: 1, releases: 1, acknowledgements: 0 });

  const fallbackLease = new FakeLease();
  const fallback = await client.convert(fallbackLease, 4, 3);
  expect(fallback.mode).toBe("synchronous-fallback");
  expect(fallbackLease.synchronousConversions).toBe(1);
  await client.close();
});

test("worker death after native release acknowledges instead of releasing twice", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const lease = new FakeLease();
  const converting = client.convert(lease, 4, 3);
  worker.finishInitialization();
  worker.markConversionReleased(0);

  worker.crash(9);
  await expect(converting).rejects.toBeInstanceOf(AsyncFrameConverterUnavailableError);
  expect(lease).toMatchObject({ transfers: 1, releases: 0, acknowledgements: 1 });
  await client.close();
});

test("a worker error without close cannot strand client disposal", async () => {
  const worker = new FakeWorker(false);
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const converting = client.convert(new FakeLease(), 4, 3);
  worker.finishInitialization();

  worker.fail("uncaught worker error");
  await expect(converting).rejects.toBeInstanceOf(AsyncFrameConverterUnavailableError);
  await expect(client.close()).resolves.toBeUndefined();
  expect(worker.terminated).toBe(true);
});

test("shutdown has a bounded terminate fallback when acknowledgement never arrives", async () => {
  const worker = new FakeWorker(false);
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker, 5);
  const client = pool.createClient("/native/test.dylib");
  const converting = client.convert(new FakeLease(), 4, 3);
  worker.finishInitialization();
  worker.finishConversion(0, 0.5);
  await converting;

  await expect(client.close()).resolves.toBeUndefined();
  expect(worker.terminated).toBe(true);
});

test("a nonzero native conversion result releases the lease and rejects the frame", async () => {
  const worker = new FakeWorker();
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const lease = new FakeLease();
  const converting = client.convert(lease, 4, 3);
  worker.finishInitialization();
  worker.finishConversion(0, 0.5, 5);

  await expect(converting).rejects.toThrow("internal error");
  expect(lease).toMatchObject({ acknowledgements: 1, releases: 0 });
  await client.close();
});

test("graceful close waits for an in-flight lease and terminates only after acknowledgement", async () => {
  const worker = new FakeWorker(false);
  const pool = new AsyncFrameConverterPool(() => worker as unknown as Worker);
  const client = pool.createClient("/native/test.dylib");
  const converting = client.convert(new FakeLease(), 4, 3);
  worker.finishInitialization();

  let closed = false;
  const closing = client.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(worker.terminated).toBe(false);

  worker.finishConversion(0, 0.75);
  await converting;
  await Promise.resolve();
  expect(worker.messages.at(-1)?.type).toBe("shutdown");
  expect(worker.terminated).toBe(false);
  worker.reply({ type: "closed" });
  await closing;
  expect(worker.terminated).toBe(true);
});

class FakeLease implements AsyncConvertibleFrameLease {
  transfers = 0;
  releases = 0;
  acknowledgements = 0;
  closes = 0;
  synchronousConversions = 0;

  convertRgba(width: number, height: number, reusable?: Uint8Array): Uint8Array {
    this.synchronousConversions += 1;
    const byteLength = width * height * 4;
    const output = reusable?.byteLength === byteLength ? reusable : new Uint8Array(byteLength);
    output.fill(0x5a);
    return output;
  }

  workerRgbaOutput(width: number, height: number, reusable?: Uint8Array) {
    const byteLength = width * height * 4;
    const bytes =
      reusable?.byteLength === byteLength && reusable.buffer instanceof SharedArrayBuffer
        ? reusable
        : new Uint8Array(new SharedArrayBuffer(byteLength));
    return { bytes, stride: width * 4 };
  }

  transfer(): FrameLeaseTransfer {
    this.transfers += 1;
    return {
      handle: 1 as Pointer,
      release: () => {
        this.releases += 1;
      },
      acknowledgeReleased: () => {
        this.acknowledgements += 1;
      },
    };
  }

  close(): void {
    this.closes += 1;
  }
}

class InvalidOutputLease extends FakeLease {
  override workerRgbaOutput(): never {
    throw new RangeError("invalid output dimensions");
  }
}

class FakeWorker extends EventTarget {
  readonly messages: FrameConversionWorkerMessage[] = [];
  terminated = false;

  constructor(private readonly acknowledgeShutdown = true) {
    super();
  }

  postMessage(message: FrameConversionWorkerMessage): void {
    this.messages.push(message);
    if (message.type === "shutdown" && this.acknowledgeShutdown) {
      this.reply({ type: "closed" });
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  conversions(): FrameConversionWorkerRequest[] {
    return this.messages.filter(
      (message): message is FrameConversionWorkerRequest => message.type === "convert",
    );
  }

  finishInitialization(infrastructureError: string | null = null): void {
    const message = [...this.messages]
      .reverse()
      .find((candidate) => candidate.type === "initialize");
    if (message?.type !== "initialize") throw new Error("no initialization to finish");
    this.reply({
      type: "initialized",
      id: message.id,
      libraryPath: message.libraryPath,
      infrastructureError,
    });
  }

  finishConversion(index: number, conversionMs: number, nativeResult = 0): void {
    const message = this.conversions()[index];
    if (!message) throw new Error(`conversion ${index} was not dispatched`);
    new Uint8Array(message.output).fill(index + 1);
    this.markConversionReleased(index);
    this.reply({
      type: "complete",
      id: message.id,
      nativeResult,
      conversionMs,
      infrastructureError: null,
    });
  }

  markConversionReleased(index: number): void {
    const message = this.conversions()[index];
    if (!message) throw new Error(`conversion ${index} was not dispatched`);
    Atomics.store(new Int32Array(message.leaseState), 0, LEASE_RELEASED);
  }

  crash(code: number): void {
    const event = new Event("close") as CloseEvent;
    Object.defineProperty(event, "code", { value: code });
    this.dispatchEvent(event);
  }

  fail(message: string): void {
    const event = new Event("error") as ErrorEvent;
    Object.defineProperty(event, "message", { value: message });
    this.dispatchEvent(event);
  }

  reply(message: FrameConversionWorkerResponse): void {
    this.dispatchEvent(new MessageEvent("message", { data: message }));
  }
}
