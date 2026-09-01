import { dlopen, FFIType, ptr } from "bun:ffi";

import { MAX_ABI_VERSION, MIN_ABI_VERSION } from "./abi-version.ts";
import {
  type FrameConversionWorkerMessage,
  type FrameConversionWorkerRequest,
  LEASE_OWNED_BY_WORKER,
  LEASE_RELEASE_IN_PROGRESS,
  LEASE_RELEASED,
} from "./frame-conversion-protocol.ts";

declare const self: Worker;

const symbols = {
  ab_live_view_abi_version: { args: [], returns: FFIType.u32 },
  ab_live_view_frame_convert_rgba: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64],
    returns: FFIType.u32,
  },
  ab_live_view_frame_release: { args: [FFIType.ptr], returns: FFIType.void },
} as const;

type WorkerLibrary = ReturnType<typeof openLibraryUnchecked>;
const libraries = new Map<string, WorkerLibrary>();

self.onmessage = (event: MessageEvent<FrameConversionWorkerMessage>) => {
  const message = event.data;
  switch (message.type) {
    case "initialize":
      initialize(message.id, message.libraryPath);
      break;
    case "convert":
      convert(message);
      break;
    case "shutdown":
      for (const library of libraries.values()) library.close();
      libraries.clear();
      postMessage({ type: "closed" });
      break;
  }
};

function initialize(id: number, libraryPath: string): void {
  let infrastructureError: string | null = null;
  try {
    workerLibrary(libraryPath);
  } catch (error) {
    infrastructureError = errorMessage(error);
  }
  postMessage({
    type: "initialized",
    id,
    libraryPath,
    infrastructureError,
  });
}

function convert(message: FrameConversionWorkerRequest): void {
  let library: WorkerLibrary | null = null;
  let nativeResult = 5;
  let conversionMs = 0;
  let infrastructureError: string | null = null;
  try {
    library = workerLibrary(message.libraryPath);
    const output = new Uint8Array(message.output);
    const startedAt = performance.now();
    nativeResult = library.symbols.ab_live_view_frame_convert_rgba(
      message.lease,
      message.width,
      message.height,
      ptr(output),
      message.stride,
      BigInt(output.byteLength),
    );
    conversionMs = performance.now() - startedAt;
  } catch (error) {
    infrastructureError = errorMessage(error);
  } finally {
    if (library) {
      try {
        releaseLease(library, message);
      } catch (error) {
        infrastructureError ??= `frame release failed: ${errorMessage(error)}`;
      }
    }
  }
  postMessage({
    type: "complete",
    id: message.id,
    nativeResult,
    conversionMs,
    infrastructureError,
  });
}

function releaseLease(library: WorkerLibrary, message: FrameConversionWorkerRequest): void {
  const state = new Int32Array(message.leaseState);
  if (
    Atomics.compareExchange(state, 0, LEASE_OWNED_BY_WORKER, LEASE_RELEASE_IN_PROGRESS) !==
    LEASE_OWNED_BY_WORKER
  ) {
    return;
  }
  try {
    library.symbols.ab_live_view_frame_release(message.lease);
  } finally {
    Atomics.store(state, 0, LEASE_RELEASED);
    Atomics.notify(state, 0);
  }
}

function workerLibrary(path: string): WorkerLibrary {
  const existing = libraries.get(path);
  if (existing) return existing;
  const library = openLibraryUnchecked(path);
  const abiVersion = library.symbols.ab_live_view_abi_version();
  if (abiVersion < MIN_ABI_VERSION || abiVersion > MAX_ABI_VERSION) {
    library.close();
    throw new Error(
      `native Live View ABI mismatch in conversion worker: ${abiVersion} is outside ${MIN_ABI_VERSION}-${MAX_ABI_VERSION}`,
    );
  }
  libraries.set(path, library);
  return library;
}

function openLibraryUnchecked(path: string) {
  return dlopen(path, symbols);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
