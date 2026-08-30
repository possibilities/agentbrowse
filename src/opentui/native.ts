import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  encodeConnectionDescriptor,
  type LiveViewConnectionDescriptor,
} from "../../client/connection.ts";
import { liveViewBuildPrefix } from "../../client/live-view-build.ts";

const MIN_ABI_VERSION = 2;
const ABI_VERSION = 3;
const SNAPSHOT_SIZE = 32;
const METRICS_SIZE = 96;
const INPUT_KIND_METRICS_SIZE = 56;
const INPUT_METRICS_SIZE = 328;
const INPUT_KIND_COUNT = 5;
const FRAME_INFO_SIZE = 48;
const CURSOR_SNAPSHOT_SIZE = 64;
const MAX_CURSOR_IMAGE_BYTES = 1024 * 1024;
const CREATE_ERROR_SIZE = 256;
const MAX_OUTPUT_DIMENSION = 8192;
const MAX_OUTPUT_PIXELS = 32 * 1024 * 1024;

const abiSymbols = {
  ab_live_view_abi_version: { args: [], returns: FFIType.u32 },
} as const;

const nativeSymbols = {
  ...abiSymbols,
  ab_live_view_session_create: {
    args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.u32],
    returns: FFIType.ptr,
  },
  ab_live_view_session_connect: { args: [FFIType.ptr], returns: FFIType.u32 },
  ab_live_view_session_close: { args: [FFIType.ptr], returns: FFIType.void },
  ab_live_view_session_destroy: { args: [FFIType.ptr], returns: FFIType.void },
  ab_live_view_session_snapshot: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_metrics: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_copy_status: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_cursor_snapshot: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_copy_cursor_image: {
    args: [FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_acquire_frame: {
    args: [FFIType.ptr, FFIType.u64],
    returns: FFIType.ptr,
  },
  ab_live_view_frame_info: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_frame_convert_rgba: {
    args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u64],
    returns: FFIType.u32,
  },
  ab_live_view_frame_release: { args: [FFIType.ptr], returns: FFIType.void },
  ab_live_view_session_request_control: { args: [FFIType.ptr], returns: FFIType.u32 },
  ab_live_view_session_release_control: { args: [FFIType.ptr], returns: FFIType.u32 },
  ab_live_view_session_pointer_move: {
    args: [FFIType.ptr, FFIType.u16, FFIType.u16],
    returns: FFIType.u32,
  },
  ab_live_view_session_pointer_button: {
    args: [FFIType.ptr, FFIType.u8, FFIType.u8],
    returns: FFIType.u32,
  },
  ab_live_view_session_scroll: {
    args: [FFIType.ptr, FFIType.i16, FFIType.i16, FFIType.u8],
    returns: FFIType.u32,
  },
  ab_live_view_session_key: {
    args: [FFIType.ptr, FFIType.u64, FFIType.u8, FFIType.u8],
    returns: FFIType.u32,
  },
  ab_live_view_session_paste: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
  ab_live_view_session_release_held_input: {
    args: [FFIType.ptr],
    returns: FFIType.void,
  },
} as const;

const nativeSymbolsV3 = {
  ...nativeSymbols,
  ab_live_view_session_input_metrics: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
    returns: FFIType.u32,
  },
} as const;

function openNativeLibraryV2(path: string) {
  return dlopen(path, nativeSymbols);
}

function openNativeLibraryV3(path: string) {
  return dlopen(path, nativeSymbolsV3);
}

type NativeLibraryV2 = ReturnType<typeof openNativeLibraryV2>;
type NativeLibraryV3 = ReturnType<typeof openNativeLibraryV3>;
type InputMetricsFunction = NativeLibraryV3["symbols"]["ab_live_view_session_input_metrics"];

interface NativeLibrary {
  abiVersion: number;
  handle: NativeLibraryV2 | NativeLibraryV3;
  symbols: NativeLibraryV2["symbols"];
  inputMetrics: InputMetricsFunction | null;
}

function openNativeLibrary(path: string, abiVersion: number): NativeLibrary {
  if (abiVersion === 2) {
    const handle = openNativeLibraryV2(path);
    return { abiVersion, handle, symbols: handle.symbols, inputMetrics: null };
  }
  const handle = openNativeLibraryV3(path);
  return {
    abiVersion,
    handle,
    symbols: handle.symbols,
    inputMetrics: handle.symbols.ab_live_view_session_input_metrics,
  };
}

const libraries = new Map<string, NativeLibrary>();

export type LiveViewLifecycle =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "failed";

export interface NativeLiveViewSnapshot {
  lifecycle: LiveViewLifecycle;
  dataOpen: boolean;
  authorized: boolean;
  controlRequested: boolean;
  readOnly: boolean;
  closed: boolean;
  remoteWidth: number;
  remoteHeight: number;
  latestFrameGeneration: bigint;
}

export interface NativeLiveViewMetrics {
  decodedFrames: bigint;
  failedFrames: bigint;
  frameSamples: bigint;
  publishedFrames: bigint;
  replacedFrames: bigint;
  pointerEvents: bigint;
  mappedPointerEvents: bigint;
  keyEvents: bigint;
  mappedKeyEvents: bigint;
  dataPacketsSent: bigint;
  dataPacketsFailed: bigint;
  input: NativeLiveViewInputMetrics | null;
}

export interface NativeInputKindMetrics {
  attempted: bigint;
  queued: bigint;
  sent: bigint;
  coalesced: bigint;
  controlDropped: bigint;
  sendFailed: bigint;
  duplicateSuppressed: bigint;
}

export interface NativeLiveViewInputMetrics {
  queueDepth: number;
  queueCapacity: number;
  epoch: bigint;
  controlWaitNs: bigint;
  controlWaitCount: bigint;
  move: NativeInputKindMetrics;
  button: NativeInputKindMetrics;
  scroll: NativeInputKindMetrics;
  key: NativeInputKindMetrics;
  paste: NativeInputKindMetrics;
}

export interface NativeFrameInfo {
  format: "i420";
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  rotationDegrees: number;
  generation: bigint;
  timestampUs: bigint;
}

export interface NativeCursorSnapshot {
  imageAvailable: boolean;
  positionAvailable: boolean;
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  positionX: number;
  positionY: number;
  imageByteLength: number;
  generation: bigint;
  imageGeneration: bigint;
  positionGeneration: bigint;
}

export function defaultNativeLibraryPath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const defaultPrefix = fileURLToPath(new URL("../../zig-out", import.meta.url));
  return join(
    liveViewBuildPrefix(defaultPrefix, environment),
    "lib",
    "libagentbrowse-live-view.dylib",
  );
}

export class NativeLiveViewSession {
  private handle: Pointer | null;

  private constructor(
    private readonly native: NativeLibrary,
    handle: Pointer,
  ) {
    this.handle = handle;
  }

  static create(
    descriptor: LiveViewConnectionDescriptor,
    libraryPath = defaultNativeLibraryPath(),
  ): NativeLiveViewSession {
    const native = library(libraryPath);
    const bytes = encodeConnectionDescriptor(descriptor);
    const errorOutput = Buffer.alloc(CREATE_ERROR_SIZE);
    const handle = native.symbols.ab_live_view_session_create(
      ptr(bytes),
      bytes.byteLength,
      ptr(errorOutput),
      errorOutput.byteLength,
    );
    if (handle === null) {
      const terminator = errorOutput.indexOf(0);
      const message = errorOutput
        .subarray(0, terminator === -1 ? undefined : terminator)
        .toString();
      throw new Error(
        `could not create Live View session: ${message || "native initialization failed"}`,
      );
    }
    return new NativeLiveViewSession(native, handle);
  }

  connect(): void {
    checkResult("connect", this.native.symbols.ab_live_view_session_connect(this.requireHandle()));
  }

  abiVersion(): number {
    return this.native.abiVersion;
  }

  snapshot(): NativeLiveViewSnapshot {
    const output = Buffer.alloc(SNAPSHOT_SIZE);
    checkResult(
      "snapshot",
      this.native.symbols.ab_live_view_session_snapshot(
        this.requireHandle(),
        ptr(output),
        output.byteLength,
      ),
    );
    const flags = output.readUInt32LE(12);
    return {
      lifecycle: lifecycle(output.readUInt32LE(8)),
      dataOpen: (flags & (1 << 0)) !== 0,
      authorized: (flags & (1 << 1)) !== 0,
      controlRequested: (flags & (1 << 2)) !== 0,
      readOnly: (flags & (1 << 3)) !== 0,
      closed: (flags & (1 << 4)) !== 0,
      remoteWidth: output.readUInt32LE(16),
      remoteHeight: output.readUInt32LE(20),
      latestFrameGeneration: output.readBigUInt64LE(24),
    };
  }

  metrics(): NativeLiveViewMetrics {
    const output = Buffer.alloc(METRICS_SIZE);
    checkResult(
      "metrics",
      this.native.symbols.ab_live_view_session_metrics(
        this.requireHandle(),
        ptr(output),
        output.byteLength,
      ),
    );
    const values = Array.from({ length: 11 }, (_, index) => output.readBigUInt64LE(8 + index * 8));
    return {
      decodedFrames: values[0]!,
      failedFrames: values[1]!,
      frameSamples: values[2]!,
      publishedFrames: values[3]!,
      replacedFrames: values[4]!,
      pointerEvents: values[5]!,
      mappedPointerEvents: values[6]!,
      keyEvents: values[7]!,
      mappedKeyEvents: values[8]!,
      dataPacketsSent: values[9]!,
      dataPacketsFailed: values[10]!,
      input: this.inputMetrics(),
    };
  }

  inputMetrics(): NativeLiveViewInputMetrics | null {
    const readMetrics = this.native.inputMetrics;
    if (!readMetrics) return null;
    const output = Buffer.alloc(INPUT_METRICS_SIZE);
    checkResult("input metrics", readMetrics(this.requireHandle(), ptr(output), output.byteLength));
    const structSize = output.readUInt32LE(0);
    const abiVersion = output.readUInt32LE(4);
    const kindCount = output.readUInt32LE(8);
    if (structSize < INPUT_METRICS_SIZE || abiVersion < 3 || kindCount < INPUT_KIND_COUNT) {
      throw new Error(
        `native Live View input metrics layout is unsupported: size=${structSize} abi=${abiVersion} kinds=${kindCount}`,
      );
    }
    const kinds = Array.from({ length: INPUT_KIND_COUNT }, (_, index) =>
      readInputKindMetrics(output, 48 + index * INPUT_KIND_METRICS_SIZE),
    );
    return {
      queueDepth: output.readUInt32LE(12),
      queueCapacity: output.readUInt32LE(16),
      epoch: output.readBigUInt64LE(24),
      controlWaitNs: output.readBigUInt64LE(32),
      controlWaitCount: output.readBigUInt64LE(40),
      move: kinds[0]!,
      button: kinds[1]!,
      scroll: kinds[2]!,
      key: kinds[3]!,
      paste: kinds[4]!,
    };
  }

  status(): string {
    const output = Buffer.alloc(256);
    const written = this.native.symbols.ab_live_view_session_copy_status(
      this.requireHandle(),
      ptr(output),
      output.byteLength,
    );
    return output.subarray(0, written).toString();
  }

  cursorSnapshot(): NativeCursorSnapshot {
    const output = Buffer.alloc(CURSOR_SNAPSHOT_SIZE);
    checkResult(
      "cursor snapshot",
      this.native.symbols.ab_live_view_session_cursor_snapshot(
        this.requireHandle(),
        ptr(output),
        output.byteLength,
      ),
    );
    const flags = output.readUInt32LE(8);
    const imageByteLength = output.readUInt32LE(36);
    if (imageByteLength > MAX_CURSOR_IMAGE_BYTES) {
      throw new Error(`native Live View cursor image exceeds ${MAX_CURSOR_IMAGE_BYTES} bytes`);
    }
    return {
      imageAvailable: (flags & (1 << 0)) !== 0,
      positionAvailable: (flags & (1 << 1)) !== 0,
      width: output.readUInt32LE(12),
      height: output.readUInt32LE(16),
      hotspotX: output.readUInt32LE(20),
      hotspotY: output.readUInt32LE(24),
      positionX: output.readUInt32LE(28),
      positionY: output.readUInt32LE(32),
      imageByteLength,
      generation: output.readBigUInt64LE(40),
      imageGeneration: output.readBigUInt64LE(48),
      positionGeneration: output.readBigUInt64LE(56),
    };
  }

  cursorImage(snapshot = this.cursorSnapshot()): Uint8Array | null {
    if (!snapshot.imageAvailable || snapshot.imageByteLength === 0) return null;
    const output = Buffer.alloc(snapshot.imageByteLength);
    const written = this.native.symbols.ab_live_view_session_copy_cursor_image(
      this.requireHandle(),
      snapshot.imageGeneration,
      ptr(output),
      output.byteLength,
    );
    return written === output.byteLength ? output : null;
  }

  acquireFrame(afterGeneration: bigint): NativeFrameLease | null {
    const handle = this.native.symbols.ab_live_view_session_acquire_frame(
      this.requireHandle(),
      afterGeneration,
    );
    return handle === null ? null : new NativeFrameLease(this.native, handle);
  }

  requestControl(): boolean {
    return this.native.symbols.ab_live_view_session_request_control(this.requireHandle()) !== 0;
  }

  releaseControl(): boolean {
    return this.native.symbols.ab_live_view_session_release_control(this.requireHandle()) !== 0;
  }

  movePointer(x: number, y: number): boolean {
    return (
      this.native.symbols.ab_live_view_session_pointer_move(
        this.requireHandle(),
        u16(x, "x"),
        u16(y, "y"),
      ) !== 0
    );
  }

  setPointerButton(button: number, pressed: boolean): boolean {
    if (!Number.isInteger(button) || button < 0 || button > 7) return false;
    return (
      this.native.symbols.ab_live_view_session_pointer_button(
        this.requireHandle(),
        button,
        pressed ? 1 : 0,
      ) !== 0
    );
  }

  scroll(deltaX: number, deltaY: number, controlKey: boolean): boolean {
    return (
      this.native.symbols.ab_live_view_session_scroll(
        this.requireHandle(),
        i16(deltaX),
        i16(deltaY),
        controlKey ? 1 : 0,
      ) !== 0
    );
  }

  setKey(keysym: bigint, pressed: boolean, repeat = false): boolean {
    return (
      this.native.symbols.ab_live_view_session_key(
        this.requireHandle(),
        keysym,
        pressed ? 1 : 0,
        repeat ? 1 : 0,
      ) !== 0
    );
  }

  paste(bytes: Uint8Array): boolean {
    if (bytes.byteLength === 0) return false;
    return (
      this.native.symbols.ab_live_view_session_paste(
        this.requireHandle(),
        ptr(bytes),
        bytes.byteLength,
      ) !== 0
    );
  }

  releaseHeldInput(): void {
    if (this.handle) this.native.symbols.ab_live_view_session_release_held_input(this.handle);
  }

  close(): void {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    this.native.symbols.ab_live_view_session_close(handle);
    this.native.symbols.ab_live_view_session_destroy(handle);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private requireHandle(): Pointer {
    if (!this.handle) throw new Error("Live View session is closed");
    return this.handle;
  }
}

export class NativeFrameLease {
  private handle: Pointer | null;

  constructor(
    private readonly native: NativeLibrary,
    handle: Pointer,
  ) {
    this.handle = handle;
  }

  info(): NativeFrameInfo {
    const output = Buffer.alloc(FRAME_INFO_SIZE);
    checkResult(
      "frame info",
      this.native.symbols.ab_live_view_frame_info(
        this.requireHandle(),
        ptr(output),
        output.byteLength,
      ),
    );
    if (output.readUInt32LE(4) !== 1) throw new Error("unsupported native frame format");
    return {
      format: "i420",
      width: output.readUInt32LE(8),
      height: output.readUInt32LE(12),
      displayWidth: output.readUInt32LE(16),
      displayHeight: output.readUInt32LE(20),
      rotationDegrees: output.readUInt32LE(24),
      generation: output.readBigUInt64LE(32),
      timestampUs: output.readBigInt64LE(40),
    };
  }

  convertRgba(width: number, height: number): Uint8Array {
    const outputWidth = positiveU32(width, "width");
    const outputHeight = positiveU32(height, "height");
    if (
      outputWidth > MAX_OUTPUT_DIMENSION ||
      outputHeight > MAX_OUTPUT_DIMENSION ||
      outputWidth * outputHeight > MAX_OUTPUT_PIXELS
    ) {
      throw new RangeError("RGBA output exceeds the native conversion limit");
    }
    const stride = outputWidth * 4;
    const byteLength = stride * outputHeight;
    if (!Number.isSafeInteger(byteLength)) throw new RangeError("RGBA output is too large");
    const output = Buffer.allocUnsafe(byteLength);
    checkResult(
      "frame conversion",
      this.native.symbols.ab_live_view_frame_convert_rgba(
        this.requireHandle(),
        outputWidth,
        outputHeight,
        ptr(output),
        stride,
        BigInt(output.byteLength),
      ),
    );
    return output;
  }

  close(): void {
    const handle = this.handle;
    if (!handle) return;
    this.handle = null;
    this.native.symbols.ab_live_view_frame_release(handle);
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private requireHandle(): Pointer {
    if (!this.handle) throw new Error("frame lease is released");
    return this.handle;
  }
}

function library(path: string): NativeLibrary {
  const existing = libraries.get(path);
  if (existing) return existing;
  if (!existsSync(path)) {
    throw new Error(
      `native Live View library is not built — run "zig build live-view-lib" (${path})`,
    );
  }
  const probe = dlopen(path, abiSymbols);
  const actualAbi = probe.symbols.ab_live_view_abi_version();
  probe.close();
  if (actualAbi < MIN_ABI_VERSION || actualAbi > ABI_VERSION) {
    throw new Error(
      `native Live View ABI mismatch: client=${MIN_ABI_VERSION}-${ABI_VERSION} library=${actualAbi}; rebuild agentbrowse`,
    );
  }
  const opened = openNativeLibrary(path, actualAbi);
  libraries.set(path, opened);
  return opened;
}

function checkResult(action: string, value: number): void {
  if (value === 0) return;
  const descriptions = [
    "ok",
    "invalid argument",
    "closed",
    "buffer too small",
    "unsupported",
    "internal error",
  ];
  throw new Error(`native Live View ${action} failed: ${descriptions[value] ?? `result ${value}`}`);
}

function readInputKindMetrics(output: Buffer, offset: number): NativeInputKindMetrics {
  const values = Array.from({ length: 7 }, (_, index) =>
    output.readBigUInt64LE(offset + index * 8),
  );
  return {
    attempted: values[0]!,
    queued: values[1]!,
    sent: values[2]!,
    coalesced: values[3]!,
    controlDropped: values[4]!,
    sendFailed: values[5]!,
    duplicateSuppressed: values[6]!,
  };
}

function lifecycle(value: number): LiveViewLifecycle {
  const values: LiveViewLifecycle[] = [
    "idle",
    "connecting",
    "connected",
    "reconnecting",
    "closed",
    "failed",
  ];
  const result = values[value];
  if (!result) throw new Error(`unknown native Live View lifecycle ${value}`);
  return result;
}

function u16(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be a u16`);
  }
  return value;
}

function i16(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-0x8000, Math.min(0x7fff, Math.round(value)));
}

function positiveU32(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be a positive u32`);
  }
  return value;
}
