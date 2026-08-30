import type { Pointer } from "bun:ffi";

export const LEASE_OWNED_BY_WORKER = 1;
export const LEASE_RELEASE_IN_PROGRESS = 2;
export const LEASE_RELEASED = 3;

export interface FrameConversionWorkerInitialize {
  type: "initialize";
  id: number;
  libraryPath: string;
}

export interface FrameConversionWorkerRequest {
  type: "convert";
  id: number;
  libraryPath: string;
  lease: Pointer;
  width: number;
  height: number;
  stride: number;
  output: SharedArrayBuffer;
  leaseState: SharedArrayBuffer;
}

export interface FrameConversionWorkerShutdown {
  type: "shutdown";
}

export type FrameConversionWorkerMessage =
  | FrameConversionWorkerInitialize
  | FrameConversionWorkerRequest
  | FrameConversionWorkerShutdown;

export interface FrameConversionWorkerInitialized {
  type: "initialized";
  id: number;
  libraryPath: string;
  infrastructureError: string | null;
}

export interface FrameConversionWorkerComplete {
  type: "complete";
  id: number;
  nativeResult: number;
  conversionMs: number;
  infrastructureError: string | null;
}

export interface FrameConversionWorkerClosed {
  type: "closed";
}

export type FrameConversionWorkerResponse =
  | FrameConversionWorkerInitialized
  | FrameConversionWorkerComplete
  | FrameConversionWorkerClosed;
