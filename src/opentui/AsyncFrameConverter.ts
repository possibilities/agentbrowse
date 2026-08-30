import type { Pointer } from "bun:ffi";

import {
  type FrameConversionWorkerComplete,
  type FrameConversionWorkerMessage,
  type FrameConversionWorkerResponse,
  LEASE_OWNED_BY_WORKER,
  LEASE_RELEASE_IN_PROGRESS,
  LEASE_RELEASED,
} from "./frame-conversion-protocol.ts";
import type { NativeWorkerRgbaOutput } from "./native.ts";

export type FrameConversionMode = "worker" | "synchronous" | "synchronous-fallback";

export interface FrameConversionResult {
  bytes: Uint8Array;
  conversionMs: number;
  roundTripMs: number;
  mode: FrameConversionMode;
}

export interface FrameLeaseTransfer {
  readonly handle: Pointer;
  release(): void;
  acknowledgeReleased(): void;
}

/** The public lease surface the scheduler owns after convert() is called. */
export interface AsyncConvertibleFrameLease {
  convertRgba(width: number, height: number, reusable?: Uint8Array): Uint8Array;
  workerRgbaOutput(width: number, height: number, reusable?: Uint8Array): NativeWorkerRgbaOutput;
  transfer(): FrameLeaseTransfer;
  close(): void;
}

export interface AsyncFrameConverterClientOptions {
  asynchronous?: boolean;
}

export class AsyncFrameConverterUnavailableError extends Error {
  override readonly name = "AsyncFrameConverterUnavailableError";
}

type WorkerFactory = () => Worker;

interface ConversionJob {
  id: number;
  libraryPath: string;
  width: number;
  height: number;
  reusable: Uint8Array | undefined;
  forceSynchronous: boolean;
  lease: AsyncConvertibleFrameLease | null;
  transfer: FrameLeaseTransfer | null;
  output: NativeWorkerRgbaOutput | null;
  leaseState: SharedArrayBuffer | null;
  dispatchedAt: number;
  resolve: (result: FrameConversionResult) => void;
  reject: (error: unknown) => void;
}

interface Initialization {
  id: number;
  libraryPath: string;
}

/**
 * Process-wide conversion scheduler. It runs at most one conversion at a time,
 * including synchronous fallback work, because each native conversion already
 * fans out across four Zig row workers.
 */
export class AsyncFrameConverterPool {
  private readonly clients = new Set<number>();
  private readonly queue: ConversionJob[] = [];
  private readonly readyLibraryPaths = new Set<string>();
  private readonly failedLibraryPaths = new Map<string, string>();
  private worker: Worker | null = null;
  private workerFailure: string | null = null;
  private initialization: Initialization | null = null;
  private inFlight: ConversionJob | null = null;
  private synchronousRunning = false;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private resolveShutdown: (() => void) | null = null;
  private shutdownTimer: ReturnType<typeof setTimeout> | null = null;
  private nextClientId = 1;
  private nextMessageId = 1;

  constructor(
    private readonly workerFactory: WorkerFactory = () =>
      new Worker(new URL("./frame-conversion-worker.ts", import.meta.url).href, {
        name: "agentbrowse-frame-conversion",
        ref: false,
      }),
    private readonly shutdownTimeoutMs = 2_000,
  ) {}

  createClient(
    libraryPath: string,
    options: AsyncFrameConverterClientOptions = {},
  ): AsyncFrameConverterClient {
    const clientId = this.nextClientId++;
    this.clients.add(clientId);
    return new AsyncFrameConverterClient(this, clientId, libraryPath, options.asynchronous ?? true);
  }

  enqueue(
    clientId: number,
    libraryPath: string,
    asynchronous: boolean,
    lease: AsyncConvertibleFrameLease,
    width: number,
    height: number,
    reusable?: Uint8Array,
  ): Promise<FrameConversionResult> {
    if (!this.clients.has(clientId)) {
      lease.close();
      return Promise.reject(new Error("frame converter client is closed"));
    }
    return new Promise<FrameConversionResult>((resolve, reject) => {
      this.queue.push({
        id: this.nextMessageId++,
        libraryPath,
        width,
        height,
        reusable,
        forceSynchronous: !asynchronous,
        lease,
        transfer: null,
        output: null,
        leaseState: null,
        dispatchedAt: 0,
        resolve,
        reject,
      });
      this.processQueue();
    });
  }

  async releaseClient(clientId: number): Promise<void> {
    this.clients.delete(clientId);
    if (this.clients.size === 0) await this.beginShutdown();
  }

  private processQueue(): void {
    if (this.inFlight || this.synchronousRunning || this.initialization) return;
    const job = this.queue[0];
    if (!job) return;

    if (job.forceSynchronous) {
      this.runSynchronous(job, "synchronous");
      return;
    }
    if (this.workerFailure || this.shuttingDown) {
      this.runSynchronous(job, "synchronous-fallback");
      return;
    }
    const pathFailure = this.failedLibraryPaths.get(job.libraryPath);
    if (pathFailure) {
      this.runSynchronous(job, "synchronous-fallback");
      return;
    }
    if (!this.ensureWorker()) {
      this.runSynchronous(job, "synchronous-fallback");
      return;
    }
    if (!this.readyLibraryPaths.has(job.libraryPath)) {
      this.initializeLibrary(job.libraryPath);
      return;
    }
    this.dispatch(job);
  }

  private ensureWorker(): boolean {
    if (this.worker) return true;
    try {
      const worker = this.workerFactory();
      this.worker = worker;
      worker.addEventListener("message", (event) => {
        if (worker !== this.worker) return;
        this.handleWorkerMessage(event.data as FrameConversionWorkerResponse);
      });
      worker.addEventListener("messageerror", () => {
        if (worker === this.worker) {
          this.abortWorker(worker, "conversion worker message decoding failed");
        }
      });
      worker.addEventListener("error", (event) => {
        if (worker !== this.worker) return;
        event.preventDefault();
        this.abortWorker(worker, event.message || "conversion worker failed");
      });
      worker.addEventListener("close", (event) => {
        if (worker !== this.worker) return;
        if (this.shuttingDown) {
          this.finishShutdown();
        } else {
          this.failWorker(`conversion worker closed unexpectedly (code ${event.code})`);
          this.worker = null;
        }
      });
      return true;
    } catch (error) {
      this.workerFailure = `conversion worker startup failed: ${errorMessage(error)}`;
      return false;
    }
  }

  private initializeLibrary(libraryPath: string): void {
    const worker = this.worker;
    if (!worker) return;
    const initialization = { id: this.nextMessageId++, libraryPath };
    this.initialization = initialization;
    try {
      worker.postMessage({
        type: "initialize",
        id: initialization.id,
        libraryPath,
      } satisfies FrameConversionWorkerMessage);
    } catch (error) {
      this.initialization = null;
      this.failWorker(`conversion worker initialization send failed: ${errorMessage(error)}`);
    }
  }

  private dispatch(job: ConversionJob): void {
    const worker = this.worker;
    const lease = job.lease;
    if (!worker || !lease) return;
    this.queue.shift();
    try {
      job.output = lease.workerRgbaOutput(job.width, job.height, job.reusable);
      job.leaseState = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      Atomics.store(new Int32Array(job.leaseState), 0, LEASE_OWNED_BY_WORKER);
      job.transfer = lease.transfer();
      job.lease = null;
    } catch (error) {
      lease.close();
      job.lease = null;
      job.reject(error);
      queueMicrotask(() => this.processQueue());
      return;
    }
    try {
      job.dispatchedAt = performance.now();
      this.inFlight = job;
      worker.postMessage({
        type: "convert",
        id: job.id,
        libraryPath: job.libraryPath,
        lease: job.transfer.handle,
        width: job.width,
        height: job.height,
        stride: job.output.stride,
        output: job.output.bytes.buffer as SharedArrayBuffer,
        leaseState: job.leaseState,
      } satisfies FrameConversionWorkerMessage);
    } catch (error) {
      this.claimBackstopRelease(job);
      this.inFlight = null;
      job.reject(
        new AsyncFrameConverterUnavailableError(
          `conversion worker dispatch failed: ${errorMessage(error)}`,
        ),
      );
      this.failWorker(`conversion worker dispatch failed: ${errorMessage(error)}`);
    }
  }

  private runSynchronous(job: ConversionJob, mode: "synchronous" | "synchronous-fallback"): void {
    const lease = job.lease;
    if (!lease) return;
    this.queue.shift();
    this.synchronousRunning = true;
    const startedAt = performance.now();
    try {
      const bytes = lease.convertRgba(job.width, job.height, job.reusable);
      const completedAt = performance.now();
      job.resolve({
        bytes,
        conversionMs: completedAt - startedAt,
        roundTripMs: completedAt - startedAt,
        mode,
      });
    } catch (error) {
      job.reject(error);
    } finally {
      lease.close();
      job.lease = null;
      this.synchronousRunning = false;
      queueMicrotask(() => this.processQueue());
    }
  }

  private handleWorkerMessage(message: FrameConversionWorkerResponse): void {
    switch (message.type) {
      case "initialized": {
        const initialization = this.initialization;
        if (!initialization || initialization.id !== message.id) return;
        this.initialization = null;
        if (message.infrastructureError) {
          this.failedLibraryPaths.set(message.libraryPath, message.infrastructureError);
        } else {
          this.readyLibraryPaths.add(message.libraryPath);
        }
        this.processQueue();
        break;
      }
      case "complete":
        this.complete(message);
        break;
      case "closed": {
        if (!this.shuttingDown) {
          this.failWorker("conversion worker closed without a shutdown request");
          return;
        }
        // terminate() is only used after the worker has acknowledged that all
        // native libraries are closed and no conversion is in flight.
        this.worker?.terminate();
        this.finishShutdown();
        break;
      }
    }
  }

  private complete(message: FrameConversionWorkerComplete): void {
    const job = this.inFlight;
    if (!job || job.id !== message.id) return;
    this.inFlight = null;
    const roundTripMs = Math.max(0, performance.now() - job.dispatchedAt);
    const released = this.acknowledgeWorkerRelease(job);
    if (!released) {
      const detail = "conversion worker completed before releasing its frame lease";
      job.reject(new AsyncFrameConverterUnavailableError(detail));
      this.failWorker(detail);
      return;
    }
    if (message.infrastructureError) {
      const detail = `conversion worker failed: ${message.infrastructureError}`;
      job.reject(new AsyncFrameConverterUnavailableError(detail));
      this.failWorker(detail);
      return;
    }
    if (message.nativeResult !== 0) {
      job.reject(nativeConversionError(message.nativeResult));
      this.processQueue();
      return;
    }
    const output = job.output;
    if (!output) {
      job.reject(new Error("conversion worker returned no RGBA output"));
      this.processQueue();
      return;
    }
    job.resolve({
      bytes: output.bytes,
      conversionMs: message.conversionMs,
      roundTripMs,
      mode: "worker",
    });
    this.processQueue();
  }

  private acknowledgeWorkerRelease(job: ConversionJob): boolean {
    const transfer = job.transfer;
    const leaseState = job.leaseState;
    if (!transfer || !leaseState) return false;
    if (Atomics.load(new Int32Array(leaseState), 0) !== LEASE_RELEASED) {
      this.claimBackstopRelease(job);
      return false;
    }
    transfer.acknowledgeReleased();
    job.transfer = null;
    return true;
  }

  private claimBackstopRelease(job: ConversionJob): void {
    const transfer = job.transfer;
    const leaseState = job.leaseState;
    if (!transfer || !leaseState) return;
    const state = new Int32Array(leaseState);
    const previous = Atomics.compareExchange(
      state,
      0,
      LEASE_OWNED_BY_WORKER,
      LEASE_RELEASE_IN_PROGRESS,
    );
    if (previous === LEASE_OWNED_BY_WORKER) {
      try {
        transfer.release();
      } finally {
        Atomics.store(state, 0, LEASE_RELEASED);
        Atomics.notify(state, 0);
      }
      job.transfer = null;
    } else if (previous === LEASE_RELEASED) {
      transfer.acknowledgeReleased();
      job.transfer = null;
    }
  }

  private failWorker(detail: string): void {
    this.workerFailure ??= detail;
    this.initialization = null;
    const job = this.inFlight;
    if (job) {
      this.inFlight = null;
      this.claimBackstopRelease(job);
      job.reject(new AsyncFrameConverterUnavailableError(detail));
    }
    this.processQueue();
  }

  private abortWorker(worker: Worker, detail: string): void {
    if (worker !== this.worker) return;
    if (this.shuttingDown) {
      worker.terminate();
      this.finishShutdown();
      return;
    }
    this.failWorker(detail);
    worker.terminate();
    if (worker === this.worker) this.worker = null;
  }

  private beginShutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (!this.worker) {
      this.resetWorkerState();
      return Promise.resolve();
    }
    if (this.queue.length > 0 || this.inFlight || this.synchronousRunning || this.initialization) {
      throw new Error("cannot close the frame conversion worker while work is outstanding");
    }
    this.shuttingDown = true;
    this.shutdownPromise = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
    const shutdown = this.shutdownPromise;
    const worker = this.worker;
    this.shutdownTimer = setTimeout(() => {
      if (!this.shuttingDown || worker !== this.worker) return;
      worker.terminate();
      this.finishShutdown();
    }, this.shutdownTimeoutMs);
    try {
      worker.postMessage({ type: "shutdown" } satisfies FrameConversionWorkerMessage);
    } catch {
      // A worker that cannot receive the graceful close message is already an
      // infrastructure failure; no native call can be synchronously running.
      worker.terminate();
      this.finishShutdown();
    }
    return shutdown;
  }

  private finishShutdown(): void {
    const resolve = this.resolveShutdown;
    if (this.shutdownTimer !== null) clearTimeout(this.shutdownTimer);
    this.worker = null;
    this.resetWorkerState();
    resolve?.();
  }

  private resetWorkerState(): void {
    this.workerFailure = null;
    this.readyLibraryPaths.clear();
    this.failedLibraryPaths.clear();
    this.initialization = null;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.resolveShutdown = null;
    this.shutdownTimer = null;
  }
}

export class AsyncFrameConverterClient {
  private active: Promise<void> | null = null;
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(
    private readonly pool: AsyncFrameConverterPool,
    private readonly clientId: number,
    private readonly libraryPath: string,
    private readonly asynchronous: boolean,
  ) {}

  get busy(): boolean {
    return this.active !== null;
  }

  convert(
    lease: AsyncConvertibleFrameLease,
    width: number,
    height: number,
    reusable?: Uint8Array,
  ): Promise<FrameConversionResult> {
    if (this.closed) {
      lease.close();
      return Promise.reject(new Error("frame converter client is closed"));
    }
    if (this.active) {
      lease.close();
      return Promise.reject(new Error("frame converter client already has a conversion in flight"));
    }
    const result = this.pool.enqueue(
      this.clientId,
      this.libraryPath,
      this.asynchronous,
      lease,
      width,
      height,
      reusable,
    );
    let settled!: Promise<void>;
    settled = result.then(
      () => {
        if (this.active === settled) this.active = null;
      },
      () => {
        if (this.active === settled) this.active = null;
      },
    );
    this.active = settled;
    return result;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      await this.active;
      await this.pool.releaseClient(this.clientId);
    })();
    return this.closePromise;
  }
}

const sharedPool = new AsyncFrameConverterPool();

export function createAsyncFrameConverterClient(
  libraryPath: string,
  options?: AsyncFrameConverterClientOptions,
): AsyncFrameConverterClient {
  return sharedPool.createClient(libraryPath, options);
}

function nativeConversionError(result: number): Error {
  const descriptions = [
    "ok",
    "invalid argument",
    "closed",
    "buffer too small",
    "unsupported",
    "internal error",
  ];
  return new Error(
    `native Live View frame conversion failed: ${descriptions[result] ?? `result ${result}`}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
