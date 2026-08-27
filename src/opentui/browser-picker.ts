import type { BrowserTargetChoice, BrowserTargetSource } from "../../client/targets.ts";
import { listBrowserTargets } from "../../client/targets.ts";

export interface BrowserPickerState {
  open: boolean;
  loading: boolean;
  choices: readonly BrowserTargetChoice[];
  selectedIndex: number;
  error: string | null;
}

export type BrowserPickerListener = (state: BrowserPickerState) => void;

export const DEFAULT_BROWSER_DISCOVERY_TIMEOUT_MS = 5_000;

/** Async Browser-target discovery with stale-result suppression and disabled rows. */
export class BrowserPickerController {
  private pickerState: BrowserPickerState = {
    open: false,
    loading: false,
    choices: [],
    selectedIndex: -1,
    error: null,
  };
  private generation = 0;
  private activeDiscovery: AbortController | null = null;

  constructor(
    private readonly source?: BrowserTargetSource,
    private readonly listener?: BrowserPickerListener,
    private readonly discoveryTimeoutMs = DEFAULT_BROWSER_DISCOVERY_TIMEOUT_MS,
  ) {}

  public state(): BrowserPickerState {
    return { ...this.pickerState, choices: [...this.pickerState.choices] };
  }

  public async open(): Promise<void> {
    const generation = ++this.generation;
    this.cancelDiscovery();
    const controller = new AbortController();
    this.activeDiscovery = controller;
    const timeout = setTimeout(() => {
      controller.abort(
        new Error(
          `Browser target discovery timed out after ${formatDuration(this.discoveryTimeoutMs)}`,
        ),
      );
    }, this.discoveryTimeoutMs);
    this.publish({
      ...this.pickerState,
      open: true,
      loading: true,
      error: null,
    });
    try {
      const choices = await abortable(
        listBrowserTargets(this.source, controller.signal),
        controller.signal,
      );
      if (generation !== this.generation || !this.pickerState.open) return;
      this.publish({
        open: true,
        loading: false,
        choices,
        selectedIndex: choices.findIndex((choice) => choice.selectable),
        error: null,
      });
    } catch (error) {
      if (generation !== this.generation || !this.pickerState.open) return;
      this.publish({
        open: true,
        loading: false,
        choices: [],
        selectedIndex: -1,
        error: errorMessage(error),
      });
    } finally {
      clearTimeout(timeout);
      if (this.activeDiscovery === controller) this.activeDiscovery = null;
    }
  }

  public close(): void {
    this.generation += 1;
    this.cancelDiscovery();
    if (!this.pickerState.open) return;
    this.publish({ ...this.pickerState, open: false, loading: false });
  }

  public move(delta: number): void {
    if (
      !this.pickerState.open ||
      this.pickerState.loading ||
      !Number.isFinite(delta) ||
      delta === 0
    )
      return;
    const selectable = this.pickerState.choices
      .map((choice, index) => (choice.selectable ? index : -1))
      .filter((index) => index >= 0);
    if (selectable.length === 0) return;
    const current = selectable.indexOf(this.pickerState.selectedIndex);
    const origin = current === -1 ? (delta > 0 ? -1 : 0) : current;
    const offset =
      (((origin + Math.sign(delta)) % selectable.length) + selectable.length) % selectable.length;
    this.publish({ ...this.pickerState, selectedIndex: selectable[offset]! });
  }

  /** A successful choice closes synchronously, before connection work begins. */
  public choose(): BrowserTargetChoice | null {
    if (!this.pickerState.open || this.pickerState.loading) return null;
    const choice = this.pickerState.choices[this.pickerState.selectedIndex];
    if (!choice?.selectable) return null;
    this.close();
    return choice;
  }

  private publish(state: BrowserPickerState): void {
    this.pickerState = state;
    this.listener?.(this.state());
  }

  private cancelDiscovery(): void {
    this.activeDiscovery?.abort(new Error("Browser target discovery cancelled"));
    this.activeDiscovery = null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDuration(milliseconds: number): string {
  if (milliseconds % 1_000 === 0) return `${milliseconds / 1_000} seconds`;
  return `${milliseconds} ms`;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
