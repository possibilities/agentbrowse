import {
  CliRenderEvents,
  ImageRenderable,
  type ImageRenderableOptions,
  type KeyEvent,
  type MouseEvent,
  NativeImage,
  type PasteEvent,
  type RenderContext,
} from "@opentui/core";
import { type ConnectionDescriptorOptions, connectionDescriptor } from "../../client/connection.ts";
import type { BrowserTargetChoice } from "../../client/targets.ts";
import { LiveViewTunnel, type TunnelOptions } from "../../client/tunnel.ts";
import { loadAgentbrowseConfig } from "../../config/deployment.ts";
import {
  type CellPixelSize,
  type FittedFrameGeometry,
  fitFrameGeometry,
  mapCellToRemote,
  terminalCellPixels,
} from "./geometry.ts";
import {
  isOpenTuiModifierKey,
  keysymForOpenTuiKey,
  openTuiModifierSnapshot,
  X11_MODIFIER_KEYSYMS,
} from "./keysym.ts";
import {
  type NativeFrameInfo,
  type NativeLiveViewMetrics,
  NativeLiveViewSession,
  type NativeLiveViewSnapshot,
} from "./native.ts";

const DEFAULT_POLL_FPS = 15;
const MIN_POLL_FPS = 1;
const MAX_POLL_FPS = 30;
const SCROLL_STEP = 19;

export type LiveViewSurfacePhase =
  | "empty"
  | "opening-tunnel"
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "closed"
  | "failed";

export interface LiveViewSurfaceState {
  phase: LiveViewSurfacePhase;
  target: BrowserTargetChoice | null;
  status: string;
  error: string | null;
}

export interface LiveViewSubmissionMetrics {
  /** Source assignments retained by ImageRenderable, not display acknowledgements. */
  submittedFrames: bigint;
  skippedFrames: bigint;
  rgbaBytes: bigint;
  rgbaBytesPerSecond: number;
  lastConversionMs: number;
  averageConversionMs: number;
  maxConversionMs: number;
  submissionAgeMs: number | null;
  outputWidth: number;
  outputHeight: number;
  latestGeneration: bigint;
  latestFrameTimestampUs: bigint | null;
}

export interface LiveViewRenderableOptions extends Omit<ImageRenderableOptions, "source" | "fit"> {
  pollFps?: number;
  nativeLibraryPath?: string;
  tunnel?: TunnelOptions;
  connection?: ConnectionDescriptorOptions;
  onStateChange?: (state: LiveViewSurfaceState) => void;
  onSubmission?: (metrics: LiveViewSubmissionMetrics) => void;
}

/**
 * A focusable OpenTUI image surface backed by one headless Live View session.
 * Bun polls the native ABI; WebRTC threads never call into JavaScript.
 */
export class LiveViewRenderable extends ImageRenderable {
  private readonly pollIntervalMs: number;
  private readonly nativeLibraryPath: string | undefined;
  private readonly tunnelOptions: TunnelOptions;
  private readonly connectionOptions: ConnectionDescriptorOptions;
  private readonly stateCallback: ((state: LiveViewSurfaceState) => void) | undefined;
  private readonly submissionCallback: ((metrics: LiveViewSubmissionMetrics) => void) | undefined;
  private readonly rendererBlurHandler = () => this.releaseHeldInput();

  private surfaceState: LiveViewSurfaceState = {
    phase: "empty",
    target: null,
    status: "No browser",
    error: null,
  };
  private target: BrowserTargetChoice | null = null;
  private tunnel: LiveViewTunnel | null = null;
  private session: NativeLiveViewSession | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private keyreleaseHandler: ((key: KeyEvent) => void) | null = null;
  private operationGeneration = 0;
  private operationAbortController: AbortController | null = null;
  private readonly pendingConnects = new Set<Promise<void>>();
  private latestGeneration = 0n;
  private latestFrameInfo: NativeFrameInfo | null = null;
  private fittedGeometry: ReturnType<typeof fitFrameGeometry> = null;
  private lastOutputWidth = 0;
  private lastOutputHeight = 0;
  private submittedFrames = 0n;
  private skippedFrames = 0n;
  private rgbaBytes = 0n;
  private bandwidthStartedAt: number | null = null;
  private conversionSamples = 0;
  private conversionTotalMs = 0;
  private conversionLastMs = 0;
  private conversionMaxMs = 0;
  private lastSubmittedAt: number | null = null;
  private latestFrameTimestampUs: bigint | null = null;
  private rgbaScratch: Uint8Array | undefined;

  constructor(context: RenderContext, options: LiveViewRenderableOptions = {}) {
    const {
      pollFps = DEFAULT_POLL_FPS,
      nativeLibraryPath,
      tunnel = {},
      connection = {},
      onStateChange,
      onSubmission,
      ...imageOptions
    } = options;
    super(context, { ...imageOptions, fit: "fit" });
    if (!Number.isFinite(pollFps) || pollFps < MIN_POLL_FPS || pollFps > MAX_POLL_FPS) {
      throw new RangeError(`pollFps must be between ${MIN_POLL_FPS} and ${MAX_POLL_FPS}`);
    }
    this.pollIntervalMs = 1000 / pollFps;
    this.nativeLibraryPath = nativeLibraryPath;
    this.tunnelOptions = tunnel;
    this.connectionOptions = connection;
    this.stateCallback = onStateChange;
    this.submissionCallback = onSubmission;
    this.focusable = true;
    this.onMouse = (event) => {
      this.forwardMouse(event);
      options.onMouse?.call(this, event);
    };
    context.on(CliRenderEvents.BLUR, this.rendererBlurHandler);
  }

  public state(): LiveViewSurfaceState {
    return { ...this.surfaceState };
  }

  public submissionMetrics(now = performance.now()): LiveViewSubmissionMetrics {
    const elapsed = this.bandwidthStartedAt === null ? 0 : now - this.bandwidthStartedAt;
    return {
      submittedFrames: this.submittedFrames,
      skippedFrames: this.skippedFrames,
      rgbaBytes: this.rgbaBytes,
      rgbaBytesPerSecond: elapsed > 0 ? (Number(this.rgbaBytes) * 1000) / elapsed : 0,
      lastConversionMs: this.conversionLastMs,
      averageConversionMs:
        this.conversionSamples > 0 ? this.conversionTotalMs / this.conversionSamples : 0,
      maxConversionMs: this.conversionMaxMs,
      submissionAgeMs:
        this.lastSubmittedAt === null ? null : Math.max(0, now - this.lastSubmittedAt),
      outputWidth: this.lastOutputWidth,
      outputHeight: this.lastOutputHeight,
      latestGeneration: this.latestGeneration,
      latestFrameTimestampUs: this.latestFrameTimestampUs,
    };
  }

  public nativeMetrics(): NativeLiveViewMetrics | null {
    return this.session?.metrics() ?? null;
  }

  public nativeSnapshot(): NativeLiveViewSnapshot | null {
    return this.session?.snapshot() ?? null;
  }

  public connect(target: BrowserTargetChoice): Promise<void> {
    const pending = this.connectTarget(target);
    this.pendingConnects.add(pending);
    void pending.then(
      () => this.pendingConnects.delete(pending),
      () => this.pendingConnects.delete(pending),
    );
    return pending;
  }

  private async connectTarget(target: BrowserTargetChoice): Promise<void> {
    if (!target.selectable) {
      throw new Error(
        `Browser target ${target.name} is unavailable${target.disabledReason ? `: ${target.disabledReason}` : ""}`,
      );
    }
    const { operation, signal } = this.beginOperation();
    await this.teardownCurrent();
    if (operation !== this.operationGeneration || this.isDestroyed) return;

    this.target = target;
    this.setSurfaceState({
      phase: "opening-tunnel",
      target,
      status: `Connecting to ${target.name}`,
      error: null,
    });

    let tunnel: LiveViewTunnel | null = null;
    let session: NativeLiveViewSession | null = null;
    try {
      const tunnelSignal = this.tunnelOptions.signal
        ? AbortSignal.any([signal, this.tunnelOptions.signal])
        : signal;
      tunnel = await LiveViewTunnel.open(target, {
        ...this.tunnelOptions,
        signal: tunnelSignal,
      });
      if (operation !== this.operationGeneration || this.isDestroyed) {
        await tunnel.close();
        return;
      }
      const liveViewConfig = loadAgentbrowseConfig().liveView;
      const descriptor = connectionDescriptor(target, tunnel.baseUrl, {
        labelPrefix: this.connectionOptions.labelPrefix ?? liveViewConfig.labelPrefix,
        username: this.connectionOptions.username ?? liveViewConfig.username,
        password: this.connectionOptions.password ?? liveViewConfig.password,
        readOnly: this.connectionOptions.readOnly ?? liveViewConfig.readOnly,
      });
      session = NativeLiveViewSession.create(descriptor, this.nativeLibraryPath);
      session.connect();
      this.tunnel = tunnel;
      this.session = session;
      this.startPolling();
      this.pollNative();
    } catch (error) {
      session?.close();
      if (tunnel) await tunnel.close();
      if (operation !== this.operationGeneration || this.isDestroyed) return;
      const message = errorMessage(error);
      this.target = target;
      this.setSurfaceState({
        phase: "failed",
        target,
        status: message,
        error: message,
      });
      throw error;
    } finally {
      if (this.operationAbortController?.signal === signal) {
        this.operationAbortController = null;
      }
    }
  }

  public async disconnect(): Promise<void> {
    const pendingConnects = [...this.pendingConnects];
    const operation = this.invalidateOperation();
    await this.teardownCurrent();
    await Promise.allSettled(pendingConnects);
    if (operation !== this.operationGeneration || this.isDestroyed) return;
    this.target = null;
    this.setSurfaceState({
      phase: "empty",
      target: null,
      status: "No browser",
      error: null,
    });
  }

  public requestControl(): boolean {
    return this.session?.requestControl() ?? false;
  }

  public releaseControl(): boolean {
    return this.session?.releaseControl() ?? false;
  }

  public releaseHeldInput(): void {
    this.session?.releaseHeldInput();
  }

  public override focus(): void {
    if (this.focused) return;
    super.focus();
    if (!this.focused) return;
    this.keyreleaseHandler = (key) => this.forwardKey(key);
    this.ctx._internalKeyInput.onInternal("keyrelease", this.keyreleaseHandler);
  }

  public override blur(): void {
    if (!this.focused) return;
    this.releaseHeldInput();
    this.removeKeyreleaseHandler();
    super.blur();
  }

  public override handleKeyPress(key: KeyEvent): boolean {
    return this.forwardKey(key);
  }

  public override handlePaste(event: PasteEvent): void {
    this.session?.paste(event.bytes);
  }

  public override destroy(): void {
    if (this.isDestroyed) return;
    this.ctx.off(CliRenderEvents.BLUR, this.rendererBlurHandler);
    this.removeKeyreleaseHandler();
    void this.disconnect();
    super.destroy();
  }

  public async dispose(): Promise<void> {
    if (this.isDestroyed) return;
    this.ctx.off(CliRenderEvents.BLUR, this.rendererBlurHandler);
    this.removeKeyreleaseHandler();
    await this.disconnect();
    if (!this.isDestroyed) super.destroy();
  }

  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.pollNative(), this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private pollNative(): void {
    const session = this.session;
    if (!session || this.isDestroyed) return;
    try {
      const snapshot = session.snapshot();
      const status = session.status();
      this.setSurfaceState({
        phase: snapshot.lifecycle,
        target: this.target,
        status,
        error: snapshot.lifecycle === "failed" ? status : null,
      });
      // A host may switch or dispose the surface from its state callback.
      // Never keep using the old native handle after that synchronous reentry.
      if (session !== this.session || this.isDestroyed) return;
      if (snapshot.lifecycle === "closed" || snapshot.lifecycle === "failed") {
        this.releaseHeldInput();
      }
      // Cursor policy: `main` frames are pointerless, and the terminal host
      // pointer is the only cursor OpenTUI presents. Deliberately do not poll or
      // composite cursor observations; remote-controller movement is therefore
      // not shown on this frontend adapter.
      if (!this.visible || this.width <= 0 || this.height <= 0) return;

      const cellPixels = terminalCellPixels(this.ctx);
      const expected = this.latestFrameInfo
        ? fitFrameGeometry(this.width, this.height, this.latestFrameInfo, cellPixels)
        : null;
      if (expected && this.lastOutputWidth > 0 && this.lastOutputHeight > 0) {
        // ImageRenderable refits its retained source whenever layout changes,
        // even when the native queue has no newer frame. Keep pointer mapping
        // on that same current rectangle.
        this.updateFittedGeometry(
          expected,
          cellPixels,
          this.lastOutputWidth,
          this.lastOutputHeight,
        );
      }
      const sizeChanged =
        expected !== null &&
        (expected.outputWidth !== this.lastOutputWidth ||
          expected.outputHeight !== this.lastOutputHeight);
      const lease = session.acquireFrame(sizeChanged ? 0n : this.latestGeneration);
      if (!lease) return;
      try {
        const info = lease.info();
        const geometry = fitFrameGeometry(this.width, this.height, info, cellPixels);
        if (!geometry) return;
        const previousGeneration = this.latestGeneration;
        this.latestGeneration = info.generation;
        this.latestFrameInfo = info;
        if (previousGeneration > 0n && info.generation > previousGeneration + 1n) {
          this.skippedFrames += info.generation - previousGeneration - 1n;
        }

        const conversionStartedAt = performance.now();
        const rgba = lease.convertRgba(
          geometry.outputWidth,
          geometry.outputHeight,
          this.rgbaScratch,
        );
        this.rgbaScratch = rgba;
        const conversionMs = performance.now() - conversionStartedAt;
        const image = NativeImage.fromRgba(rgba, geometry.outputWidth, geometry.outputHeight);
        try {
          this.source = image;
        } finally {
          image.dispose();
        }

        this.updateFittedGeometry(
          geometry,
          cellPixels,
          geometry.outputWidth,
          geometry.outputHeight,
        );
        this.lastOutputWidth = geometry.outputWidth;
        this.lastOutputHeight = geometry.outputHeight;
        this.submittedFrames += 1n;
        this.rgbaBytes += BigInt(rgba.byteLength);
        this.bandwidthStartedAt ??= performance.now();
        this.conversionSamples += 1;
        this.conversionTotalMs += conversionMs;
        this.conversionLastMs = conversionMs;
        this.conversionMaxMs = Math.max(this.conversionMaxMs, conversionMs);
        this.lastSubmittedAt = performance.now();
        this.latestFrameTimestampUs = info.timestampUs;
        this.submissionCallback?.(this.submissionMetrics());
      } finally {
        lease.close();
      }
    } catch (error) {
      this.stopPolling();
      this.releaseHeldInput();
      const message = errorMessage(error);
      this.setSurfaceState({
        phase: "failed",
        target: this.target,
        status: message,
        error: message,
      });
    }
  }

  private forwardKey(key: KeyEvent): boolean {
    const session = this.session;
    if (!session) return false;
    const modifiers = openTuiModifierSnapshot(key);
    setModifiers(session, modifiers);
    if (isOpenTuiModifierKey(key)) return true;

    const keysym = keysymForOpenTuiKey(key);
    if (keysym === null) {
      if (key.source === "raw") clearModifiers(session);
      return false;
    }
    const pressed = key.eventType !== "release";
    session.setKey(keysym, pressed, Boolean(key.repeated));
    // A terminal without Kitty event types reports presses only. Treat those
    // as taps so one legacy input cannot remain held until the next blur.
    if (pressed && key.source === "raw" && !key.repeated) {
      session.setKey(keysym, false);
      clearModifiers(session);
    }
    return true;
  }

  private forwardMouse(event: MouseEvent): void {
    const session = this.session;
    const geometry = this.fittedGeometry;
    if (!session || !geometry) return;
    const point = mapCellToRemote(event.x - this.screenX, event.y - this.screenY, geometry);
    if (!point) {
      // OpenTUI keeps sending a captured drag to its origin renderable. A
      // release over the letterbox must still end the guest-side drag.
      if ((event.type === "up" || event.type === "drag-end") && validPointerButton(event.button)) {
        session.setPointerButton(event.button, false);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }

    if (event.type === "down") this.focus();
    session.movePointer(point.x, point.y);
    switch (event.type) {
      case "down":
        if (validPointerButton(event.button)) {
          session.setPointerButton(event.button, true);
        }
        break;
      case "up":
      case "drag-end":
        if (validPointerButton(event.button)) {
          session.setPointerButton(event.button, false);
        }
        break;
      case "scroll": {
        const direction = event.scroll?.direction;
        const amount = Math.max(1, event.scroll?.delta ?? 1) * SCROLL_STEP;
        const deltaX = direction === "left" ? -amount : direction === "right" ? amount : 0;
        const deltaY = direction === "up" ? -amount : direction === "down" ? amount : 0;
        session.scroll(deltaX, deltaY, event.modifiers.ctrl);
        break;
      }
      default:
        break;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  private updateFittedGeometry(
    geometry: FittedFrameGeometry,
    cellPixels: CellPixelSize,
    outputWidth: number,
    outputHeight: number,
  ): void {
    const exactFit = this.getFittedSize(
      this.width,
      this.height,
      cellPixels.height / cellPixels.width,
      outputWidth,
      outputHeight,
    );
    this.fittedGeometry = {
      ...geometry,
      outputWidth,
      outputHeight,
      cellX: Math.floor((this.width - exactFit.width) / 2),
      cellY: Math.floor((this.height - exactFit.height) / 2),
      cellWidth: exactFit.width,
      cellHeight: exactFit.height,
    };
  }

  private async teardownCurrent(): Promise<void> {
    this.stopPolling();
    const session = this.session;
    const tunnel = this.tunnel;
    this.session = null;
    this.tunnel = null;
    session?.releaseHeldInput();
    session?.close();
    this.source = undefined;
    this.rgbaScratch = undefined;
    this.fittedGeometry = null;
    this.latestFrameInfo = null;
    this.resetPresentationMetrics();
    if (tunnel) await tunnel.close();
  }

  private resetPresentationMetrics(): void {
    this.latestGeneration = 0n;
    this.lastOutputWidth = 0;
    this.lastOutputHeight = 0;
    this.submittedFrames = 0n;
    this.skippedFrames = 0n;
    this.rgbaBytes = 0n;
    this.bandwidthStartedAt = null;
    this.conversionSamples = 0;
    this.conversionTotalMs = 0;
    this.conversionLastMs = 0;
    this.conversionMaxMs = 0;
    this.lastSubmittedAt = null;
    this.latestFrameTimestampUs = null;
  }

  private removeKeyreleaseHandler(): void {
    if (!this.keyreleaseHandler) return;
    this.ctx._internalKeyInput.offInternal("keyrelease", this.keyreleaseHandler);
    this.keyreleaseHandler = null;
  }

  private beginOperation(): { operation: number; signal: AbortSignal } {
    this.operationAbortController?.abort();
    const controller = new AbortController();
    this.operationAbortController = controller;
    return { operation: ++this.operationGeneration, signal: controller.signal };
  }

  private invalidateOperation(): number {
    this.operationAbortController?.abort();
    this.operationAbortController = null;
    return ++this.operationGeneration;
  }

  private setSurfaceState(state: LiveViewSurfaceState): void {
    if (sameState(this.surfaceState, state)) return;
    this.surfaceState = state;
    this.stateCallback?.({ ...state });
  }
}

function setModifiers(
  session: NativeLiveViewSession,
  modifiers: ReturnType<typeof openTuiModifierSnapshot>,
): void {
  session.setKey(X11_MODIFIER_KEYSYMS.shift, modifiers.shift);
  session.setKey(X11_MODIFIER_KEYSYMS.control, modifiers.control);
  session.setKey(X11_MODIFIER_KEYSYMS.alt, modifiers.alt);
  session.setKey(X11_MODIFIER_KEYSYMS.meta, modifiers.meta);
  session.setKey(X11_MODIFIER_KEYSYMS.hyper, modifiers.hyper);
}

function clearModifiers(session: NativeLiveViewSession): void {
  for (const keysym of Object.values(X11_MODIFIER_KEYSYMS)) session.setKey(keysym, false);
}

function validPointerButton(button: number): boolean {
  return Number.isInteger(button) && button >= 0 && button <= 2;
}

function sameState(left: LiveViewSurfaceState, right: LiveViewSurfaceState): boolean {
  return (
    left.phase === right.phase &&
    left.target === right.target &&
    left.status === right.status &&
    left.error === right.error
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
