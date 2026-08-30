import { resolve } from "node:path";
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
  type AsyncFrameConverterClient,
  AsyncFrameConverterUnavailableError,
  createAsyncFrameConverterClient,
  type FrameConversionResult,
} from "./AsyncFrameConverter.ts";
import {
  type CellPixelSize,
  type FittedFrameGeometry,
  fitFrameGeometry,
  mapCellToRemote,
  mapPixelToRemote,
  terminalCellPixels,
} from "./geometry.ts";
import {
  applyOpenTuiKeyTargetModifiers,
  isOpenTuiLocalShortcut,
  isOpenTuiModifierKey,
  keysymForOpenTuiKey,
  type OpenTuiKeyTarget,
  openTuiKeyLevelRemovesShift,
  openTuiKeyLevelRequiresShift,
  openTuiModifierSnapshot,
  openTuiPhysicalKeyIdentity,
  openTuiShortcutTranslation,
  X11_MODIFIER_KEYSYMS,
} from "./keysym.ts";
import {
  defaultNativeLibraryPath,
  type NativeFrameInfo,
  type NativeFrameLease,
  type NativeLiveViewMetrics,
  NativeLiveViewSession,
  type NativeLiveViewSnapshot,
} from "./native.ts";
import { openTuiScrollDelta } from "./scroll.ts";

const DEFAULT_POLL_FPS = 15;
const MIN_POLL_FPS = 1;
const MAX_POLL_FPS = 30;

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
  lastConversionRoundTripMs: number;
  averageConversionRoundTripMs: number;
  maxConversionRoundTripMs: number;
  busySkips: bigint;
  staleConversions: bigint;
  synchronousFallbacks: bigint;
  submissionAgeMs: number | null;
  outputWidth: number;
  outputHeight: number;
  latestGeneration: bigint;
  latestFrameTimestampUs: bigint | null;
}

export interface LiveViewRenderableOptions extends Omit<ImageRenderableOptions, "source" | "fit"> {
  pollFps?: number;
  nativeLibraryPath?: string;
  conversionMode?: "async" | "synchronous";
  tunnel?: TunnelOptions;
  connection?: ConnectionDescriptorOptions;
  onStateChange?: (state: LiveViewSurfaceState) => void;
  onSubmission?: (metrics: LiveViewSubmissionMetrics) => void;
}

interface ActiveOpenTuiKey {
  name: string;
  target: OpenTuiKeyTarget;
}

/**
 * A focusable OpenTUI image surface backed by one headless Live View session.
 * Bun polls the native ABI; WebRTC threads never call into JavaScript.
 */
export class LiveViewRenderable extends ImageRenderable {
  private readonly pollIntervalMs: number;
  private readonly nativeLibraryPath: string;
  private readonly frameConverter: AsyncFrameConverterClient;
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
  private readonly activeKeys = new Map<string, ActiveOpenTuiKey>();
  private lastInputGate: { dataOpen: boolean; authorized: boolean } | null = null;
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
  private conversionRoundTripTotalMs = 0;
  private conversionRoundTripLastMs = 0;
  private conversionRoundTripMaxMs = 0;
  private busySkips = 0n;
  private staleConversions = 0n;
  private synchronousFallbacks = 0n;
  private lastSubmittedAt: number | null = null;
  private latestFrameTimestampUs: bigint | null = null;
  private rgbaScratch: Uint8Array | undefined;
  private activeConversion: Promise<void> | null = null;
  private frameConverterClose: Promise<void> | null = null;
  private presentationEpoch = 0;

  constructor(context: RenderContext, options: LiveViewRenderableOptions = {}) {
    const {
      pollFps = DEFAULT_POLL_FPS,
      nativeLibraryPath,
      conversionMode = "async",
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
    if (conversionMode !== "async" && conversionMode !== "synchronous") {
      throw new RangeError("conversionMode must be async or synchronous");
    }
    this.pollIntervalMs = 1000 / pollFps;
    this.nativeLibraryPath = resolve(nativeLibraryPath ?? defaultNativeLibraryPath());
    this.frameConverter = createAsyncFrameConverterClient(this.nativeLibraryPath, {
      asynchronous: conversionMode === "async",
    });
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
      lastConversionRoundTripMs: this.conversionRoundTripLastMs,
      averageConversionRoundTripMs:
        this.conversionSamples > 0 ? this.conversionRoundTripTotalMs / this.conversionSamples : 0,
      maxConversionRoundTripMs: this.conversionRoundTripMaxMs,
      busySkips: this.busySkips,
      staleConversions: this.staleConversions,
      synchronousFallbacks: this.synchronousFallbacks,
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
    this.activeKeys.clear();
    return this.session?.releaseControl() ?? false;
  }

  public releaseHeldInput(): void {
    this.activeKeys.clear();
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
    void this.destroyResources().catch(() => undefined);
    super.destroy();
  }

  public async dispose(): Promise<void> {
    if (this.isDestroyed) return;
    this.ctx.off(CliRenderEvents.BLUR, this.rendererBlurHandler);
    this.removeKeyreleaseHandler();
    await this.destroyResources();
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
      const previousInputGate = this.lastInputGate;
      if (
        (previousInputGate?.dataOpen === true && !snapshot.dataOpen) ||
        (previousInputGate?.authorized === true && !snapshot.authorized)
      ) {
        this.activeKeys.clear();
      }
      this.lastInputGate = {
        dataOpen: snapshot.dataOpen,
        authorized: snapshot.authorized,
      };
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
      if (this.activeConversion) {
        this.busySkips += 1n;
        return;
      }
      const sizeChanged =
        expected !== null &&
        (expected.outputWidth !== this.lastOutputWidth ||
          expected.outputHeight !== this.lastOutputHeight);
      const lease = session.acquireFrame(sizeChanged ? 0n : this.latestGeneration);
      if (!lease) return;
      let conversionStarted = false;
      try {
        const info = lease.info();
        const geometry = fitFrameGeometry(this.width, this.height, info, cellPixels);
        if (!geometry) return;
        this.startFrameConversion(
          session,
          lease,
          info,
          geometry.outputWidth,
          geometry.outputHeight,
        );
        conversionStarted = true;
      } finally {
        if (!conversionStarted) lease.close();
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

  private startFrameConversion(
    session: NativeLiveViewSession,
    lease: NativeFrameLease,
    info: NativeFrameInfo,
    outputWidth: number,
    outputHeight: number,
  ): void {
    const operation = this.operationGeneration;
    const presentationEpoch = this.presentationEpoch;
    let task!: Promise<void>;
    task = this.convertAndSubmitFrame(
      session,
      lease,
      info,
      outputWidth,
      outputHeight,
      operation,
      presentationEpoch,
    )
      .catch((error) => {
        if (error instanceof AsyncFrameConverterUnavailableError) return;
        if (
          session !== this.session ||
          operation !== this.operationGeneration ||
          presentationEpoch !== this.presentationEpoch ||
          this.isDestroyed
        ) {
          return;
        }
        this.stopPolling();
        this.releaseHeldInput();
        const message = errorMessage(error);
        this.setSurfaceState({
          phase: "failed",
          target: this.target,
          status: message,
          error: message,
        });
      })
      .finally(() => {
        if (this.activeConversion === task) this.activeConversion = null;
      });
    this.activeConversion = task;
  }

  private async convertAndSubmitFrame(
    session: NativeLiveViewSession,
    lease: NativeFrameLease,
    info: NativeFrameInfo,
    outputWidth: number,
    outputHeight: number,
    operation: number,
    presentationEpoch: number,
  ): Promise<void> {
    const result = await this.frameConverter.convert(
      lease,
      outputWidth,
      outputHeight,
      this.rgbaScratch,
    );
    this.recordConversion(result);

    const cellPixels = terminalCellPixels(this.ctx);
    const currentGeometry = fitFrameGeometry(this.width, this.height, info, cellPixels);
    if (
      session !== this.session ||
      operation !== this.operationGeneration ||
      presentationEpoch !== this.presentationEpoch ||
      this.isDestroyed ||
      !this.visible ||
      !currentGeometry ||
      currentGeometry.outputWidth !== outputWidth ||
      currentGeometry.outputHeight !== outputHeight ||
      result.bytes.byteLength !== outputWidth * outputHeight * 4
    ) {
      this.staleConversions += 1n;
      return;
    }

    const image = NativeImage.fromRgba(result.bytes, outputWidth, outputHeight);
    try {
      this.source = image;
    } finally {
      image.dispose();
    }
    // NativeImage has synchronously copied the RGBA bytes; only now may the
    // next conversion reuse and overwrite the shared backing buffer.
    this.rgbaScratch = result.bytes;

    const previousGeneration = this.latestGeneration;
    this.latestGeneration = info.generation;
    this.latestFrameInfo = info;
    if (previousGeneration > 0n && info.generation > previousGeneration + 1n) {
      this.skippedFrames += info.generation - previousGeneration - 1n;
    }
    this.updateFittedGeometry(currentGeometry, cellPixels, outputWidth, outputHeight);
    this.lastOutputWidth = outputWidth;
    this.lastOutputHeight = outputHeight;
    this.submittedFrames += 1n;
    this.rgbaBytes += BigInt(result.bytes.byteLength);
    const submittedAt = performance.now();
    this.bandwidthStartedAt ??= submittedAt;
    this.lastSubmittedAt = submittedAt;
    this.latestFrameTimestampUs = info.timestampUs;
    this.submissionCallback?.(this.submissionMetrics());
  }

  private recordConversion(result: FrameConversionResult): void {
    this.conversionSamples += 1;
    this.conversionTotalMs += result.conversionMs;
    this.conversionLastMs = result.conversionMs;
    this.conversionMaxMs = Math.max(this.conversionMaxMs, result.conversionMs);
    this.conversionRoundTripTotalMs += result.roundTripMs;
    this.conversionRoundTripLastMs = result.roundTripMs;
    this.conversionRoundTripMaxMs = Math.max(this.conversionRoundTripMaxMs, result.roundTripMs);
    if (result.mode === "synchronous-fallback") this.synchronousFallbacks += 1n;
  }

  private forwardKey(key: KeyEvent): boolean {
    const session = this.session;
    if (!session) return false;
    if (isOpenTuiLocalShortcut(key)) return false;

    const physicalModifiers = openTuiModifierSnapshot(key);
    if (isOpenTuiModifierKey(key)) {
      setModifiers(session, physicalModifiers);
      return true;
    }

    const pressed = key.eventType !== "release";
    const raw = key.source === "raw";
    const identity = openTuiPhysicalKeyIdentity(key);
    const active = raw ? null : this.findActiveKey(key);
    const sameNameActive =
      !raw && pressed && active === null ? this.findActiveKeyByName(key.name) : null;
    let target = active?.[1].target ?? sameNameActive?.[1].target ?? null;
    if (target === null) {
      if (pressed) target = openTuiShortcutTranslation(key);
      if (target === null) {
        const keysym = keysymForOpenTuiKey(key);
        if (keysym !== null) {
          target = {
            keysym,
            forceControl: false,
            forceAlt: false,
            forceShift: openTuiKeyLevelRequiresShift(key),
            removeShift: openTuiKeyLevelRemovesShift(key),
            removeAlt: false,
            removeMeta: false,
          };
        }
      }
    }

    if (target === null) {
      if (raw) clearModifiers(session);
      else setModifiers(session, physicalModifiers);
      return false;
    }
    if (!pressed) {
      session.setKey(target.keysym, false, Boolean(key.repeated));
      if (active) this.activeKeys.delete(active[0]);
      setModifiers(session, physicalModifiers);
      return true;
    }

    const effectiveModifiers = applyOpenTuiKeyTargetModifiers(physicalModifiers, target);
    setModifiers(session, effectiveModifiers);
    const accepted = session.setKey(target.keysym, pressed, Boolean(key.repeated));
    // A terminal without Kitty event types reports presses only. Treat those
    // as taps so one legacy input cannot remain held until the next blur.
    if (pressed && raw) {
      session.setKey(target.keysym, false);
      clearModifiers(session);
    } else {
      if (active === null && sameNameActive !== null) {
        this.activeKeys.delete(sameNameActive[0]);
        this.activeKeys.set(identity, { name: key.name.toLowerCase(), target });
      } else if (active === null && accepted) {
        const name = key.name.toLowerCase();
        this.activeKeys.set(identity, { name, target });
      } else if (active === null && !accepted) {
        setModifiers(session, physicalModifiers);
      }
    }
    return true;
  }

  private findActiveKey(key: KeyEvent): [string, ActiveOpenTuiKey] | null {
    const identity = openTuiPhysicalKeyIdentity(key);
    const exact = this.activeKeys.get(identity);
    if (exact) return [identity, exact];
    if (key.eventType !== "release") return null;
    return this.findActiveKeyByName(key.name);
  }

  private findActiveKeyByName(nameValue: string): [string, ActiveOpenTuiKey] | null {
    const name = nameValue.toLowerCase();
    for (const entry of this.activeKeys) {
      if (entry[1].name === name) return entry;
    }
    return null;
  }

  private forwardMouse(event: MouseEvent): void {
    const session = this.session;
    const geometry = this.fittedGeometry;
    if (!session || !geometry) return;
    const pixelEvent = event as MouseEvent & {
      readonly pixelX?: number;
      readonly pixelY?: number;
    };
    const cellPixels = terminalCellPixels(this.ctx);
    const point =
      pixelEvent.pixelX !== undefined && pixelEvent.pixelY !== undefined
        ? mapPixelToRemote(
            pixelEvent.pixelX - this.screenX * cellPixels.width,
            pixelEvent.pixelY - this.screenY * cellPixels.height,
            geometry,
            cellPixels,
          )
        : mapCellToRemote(event.x - this.screenX, event.y - this.screenY, geometry);
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
        const delta = openTuiScrollDelta(event.scroll?.direction, event.scroll?.delta);
        if (delta) session.scroll(delta.deltaX, delta.deltaY, event.modifiers.ctrl);
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
    this.presentationEpoch += 1;
    this.activeKeys.clear();
    this.lastInputGate = null;
    session?.releaseHeldInput();
    session?.close();
    const activeConversion = this.activeConversion;
    if (activeConversion) await activeConversion;
    if (!this.isDestroyed) this.source = undefined;
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
    this.conversionRoundTripTotalMs = 0;
    this.conversionRoundTripLastMs = 0;
    this.conversionRoundTripMaxMs = 0;
    this.busySkips = 0n;
    this.staleConversions = 0n;
    this.synchronousFallbacks = 0n;
    this.lastSubmittedAt = null;
    this.latestFrameTimestampUs = null;
  }

  private closeFrameConverter(): Promise<void> {
    this.frameConverterClose ??= this.frameConverter.close();
    return this.frameConverterClose;
  }

  private async destroyResources(): Promise<void> {
    try {
      await this.disconnect();
    } finally {
      await this.closeFrameConverter();
    }
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
