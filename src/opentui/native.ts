import { dlopen, FFIType, type Pointer, ptr } from "bun:ffi";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  encodeConnectionDescriptor,
  type LiveViewConnectionDescriptor,
} from "../../client/connection.ts";

const ABI_VERSION = 1;
const SNAPSHOT_SIZE = 32;
const METRICS_SIZE = 96;
const FRAME_INFO_SIZE = 48;
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

function openNativeLibrary(path: string) {
  return dlopen(path, nativeSymbols);
}

type NativeLibrary = ReturnType<typeof openNativeLibrary>;
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

export function defaultNativeLibraryPath(): string {
  return fileURLToPath(
    new URL("../../zig-out/lib/libagentbrowse-live-view.dylib", import.meta.url),
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
  if (actualAbi !== ABI_VERSION) {
    throw new Error(
      `native Live View ABI mismatch: client=${ABI_VERSION} library=${actualAbi}; rebuild agentbrowse`,
    );
  }
  const opened = openNativeLibrary(path);
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
