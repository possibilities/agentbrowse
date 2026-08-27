#!/usr/bin/env bun

import {
  BoxRenderable,
  bold,
  CliRenderEvents,
  CliRenderer,
  fg,
  type KeyEvent,
  StyledText,
  TextAttributes,
  type TextChunk,
  TextRenderable,
} from "@opentui/core";

import { BrowserPickerController, type BrowserPickerState } from "../src/opentui/browser-picker.ts";
import {
  LiveViewRenderable,
  type LiveViewSurfaceState,
} from "../src/opentui/LiveViewRenderable.ts";
import {
  type FxnkRamp,
  type FxnkTheme,
  FxnkThemeMonitor,
  fxnkRamp,
  resolveFxnkTheme,
} from "../src/opentui/palette.ts";

const PICKER_TITLE = " browser ";
const PICKER_MAX_WIDTH = 68;
export const FXNK_MODAL_PADDING_X = 1;
const PICKER_BORDER_CELLS_X = 2;

class OpenTuiBrowserApp {
  private readonly stage: BoxRenderable;
  private readonly liveView: LiveViewRenderable;
  private readonly emptyState: TextRenderable;
  private readonly pickerBackdrop: BoxRenderable;
  private readonly pickerBox: BoxRenderable;
  private readonly pickerText: TextRenderable;
  private readonly picker: BrowserPickerController;
  private ramp: FxnkRamp;
  private shuttingDown = false;

  private readonly keypressHandler = (key: KeyEvent) => this.onKeyPress(key);
  private readonly resizeHandler = () => this.renderPicker();
  private readonly destroyHandler = () => this.onRendererDestroyed();

  constructor(
    private readonly renderer: CliRenderer,
    initialTheme: FxnkTheme,
  ) {
    this.ramp = fxnkRamp(initialTheme);
    renderer.setBackgroundColor(this.ramp.background);
    this.stage = new BoxRenderable(renderer, {
      id: "agentbrowse-opentui-stage",
      width: "100%",
      height: "100%",
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: this.ramp.background,
    });

    this.liveView = new LiveViewRenderable(renderer, {
      id: "agentbrowse-live-view",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      visible: false,
      pollFps: 15,
      onStateChange: (state) => this.onLiveViewState(state),
      onSubmission: () => this.onSubmission(),
    });
    this.emptyState = new TextRenderable(renderer, {
      id: "agentbrowse-empty-state",
      content: "no browser",
      fg: this.ramp.dim,
      selectable: false,
    });

    this.pickerBackdrop = new BoxRenderable(renderer, {
      id: "agentbrowse-browser-picker-backdrop",
      position: "absolute",
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
      zIndex: 100,
      visible: false,
      backgroundColor: this.ramp.backdrop,
      onMouseDown: () => this.closePicker(),
    });
    this.pickerBox = new BoxRenderable(renderer, {
      id: "agentbrowse-browser-picker",
      position: "absolute",
      left: "50%",
      top: "50%",
      width: 32,
      height: 3,
      marginLeft: -16,
      marginTop: -1,
      paddingX: FXNK_MODAL_PADDING_X,
      border: true,
      borderStyle: "single",
      borderColor: this.ramp.focus,
      focusedBorderColor: this.ramp.focus,
      backgroundColor: this.ramp.background,
      title: PICKER_TITLE,
      titleColor: this.ramp.foreground,
      titleAlignment: "left",
      onMouseDown: (event) => event.stopPropagation(),
    });
    this.pickerText = new TextRenderable(renderer, {
      id: "agentbrowse-browser-picker-rows",
      width: "100%",
      height: "100%",
      content: "loading…",
      fg: this.ramp.dim,
      bg: this.ramp.background,
      wrapMode: "none",
      truncate: true,
      selectable: false,
    });
    this.pickerBox.add(this.pickerText);
    this.pickerBackdrop.add(this.pickerBox);

    this.stage.add(this.liveView);
    this.stage.add(this.emptyState);
    this.stage.add(this.pickerBackdrop);
    renderer.root.add(this.stage);

    this.picker = new BrowserPickerController(undefined, () => this.renderPicker());
    renderer.keyInput.on("keypress", this.keypressHandler);
    renderer.on(CliRenderEvents.RESIZE, this.resizeHandler);
    renderer.on(CliRenderEvents.DESTROY, this.destroyHandler);
  }

  public start(): void {
    this.renderer.start();
  }

  /** Replace the complete fxnk token set in one render turn. */
  public setTheme(theme: FxnkTheme): void {
    this.ramp = fxnkRamp(theme);
    this.renderer.setBackgroundColor(this.ramp.background);
    this.stage.backgroundColor = this.ramp.background;
    this.pickerBackdrop.backgroundColor = this.ramp.backdrop;
    this.pickerBox.backgroundColor = this.ramp.background;
    this.pickerBox.titleColor = this.ramp.foreground;
    this.pickerText.bg = this.ramp.background;
    this.onLiveViewState(this.liveView.state());
    this.renderPicker();
    this.renderer.requestRender();
  }

  public async shutdown(exitCode = 0): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.removeListeners();
    this.picker.close();
    await this.liveView.dispose();
    this.stage.destroyRecursively();
    this.renderer.destroy();
    process.exitCode = exitCode;
  }

  private onKeyPress(key: KeyEvent): void {
    if (isCtrlC(key)) {
      ownKey(key);
      void this.shutdown(0);
      return;
    }
    if (isBrowserPickerKey(key)) {
      ownKey(key);
      if (key.repeated) return;
      if (this.picker.state().open) this.closePicker();
      else this.openPicker();
      return;
    }
    if (!this.picker.state().open) return;

    ownKey(key);
    switch (key.name.toLowerCase()) {
      case "escape":
        this.closePicker();
        break;
      case "up":
        this.picker.move(-1);
        break;
      case "down":
        this.picker.move(1);
        break;
      case "enter":
      case "return":
        this.chooseBrowserTarget();
        break;
      default:
        break;
    }
  }

  private openPicker(): void {
    this.liveView.releaseHeldInput();
    this.liveView.blur();
    void this.picker.open();
  }

  private closePicker(): void {
    this.picker.close();
    if (this.liveView.state().target) this.liveView.focus();
  }

  private chooseBrowserTarget(): void {
    const target = this.picker.choose();
    if (!target) return;
    this.liveView.visible = true;
    this.emptyState.visible = true;
    this.emptyState.content = `connecting to ${target.name}`;
    this.emptyState.fg = this.ramp.dim;
    this.emptyState.attributes = TextAttributes.NONE;
    void this.liveView
      .connect(target)
      .then(() => this.liveView.focus())
      .catch(() => undefined);
  }

  private renderPicker(): void {
    const state = this.picker.state();
    this.pickerBackdrop.visible = state.open;
    if (!state.open) return;

    const maxRows = Math.max(1, this.renderer.height - 4);
    const rows = pickerRows(state, maxRows, this.ramp);
    const width = pickerModalWidth(rows.plain, this.renderer.width);
    const height = Math.max(3, rows.plain.length + 2);
    this.pickerBox.width = width;
    this.pickerBox.height = height;
    this.pickerBox.marginLeft = -Math.floor(width / 2);
    this.pickerBox.marginTop = -Math.floor(height / 2);
    this.pickerText.content = rows.styled;
    const border = state.error ? this.ramp.error : this.ramp.focus;
    this.pickerBox.borderColor = border;
    this.pickerBox.focusedBorderColor = border;
  }

  private onLiveViewState(state: LiveViewSurfaceState): void {
    if (state.phase === "empty") {
      this.liveView.visible = false;
      this.emptyState.visible = true;
      this.emptyState.content = "no browser";
      this.emptyState.fg = this.ramp.dim;
      this.emptyState.attributes = TextAttributes.NONE;
      return;
    }
    this.liveView.visible = true;
    if (state.phase === "failed") {
      this.emptyState.visible = true;
      this.emptyState.content = state.status;
      this.emptyState.fg = this.ramp.accent;
      this.emptyState.attributes = TextAttributes.BOLD;
      return;
    }
    if (this.liveView.submissionMetrics().submittedFrames === 0n) {
      this.emptyState.visible = true;
      this.emptyState.content = state.status.toLowerCase();
      this.emptyState.fg = this.ramp.dim;
      this.emptyState.attributes = TextAttributes.NONE;
    }
  }

  private onSubmission(): void {
    this.emptyState.visible = false;
  }

  private onRendererDestroyed(): void {
    this.shuttingDown = true;
    this.removeListeners();
    this.liveView.releaseHeldInput();
  }

  private removeListeners(): void {
    this.renderer.keyInput.off("keypress", this.keypressHandler);
    this.renderer.off(CliRenderEvents.RESIZE, this.resizeHandler);
    this.renderer.off(CliRenderEvents.DESTROY, this.destroyHandler);
  }
}

export function pickerRows(
  state: BrowserPickerState,
  maxRows: number,
  ramp: FxnkRamp,
): { styled: StyledText; plain: string[] } {
  if (state.loading) {
    return { styled: new StyledText([fg(ramp.dim)("loading…")]), plain: ["loading…"] };
  }
  if (state.error) {
    return {
      styled: new StyledText([bold(fg(ramp.accent)(state.error))]),
      plain: [state.error],
    };
  }
  if (state.choices.length === 0) {
    return {
      styled: new StyledText([fg(ramp.dim)("no browser targets")]),
      plain: ["no browser targets"],
    };
  }

  const start = pickerWindowStart(state.choices.length, state.selectedIndex, maxRows);
  const visible = state.choices.slice(start, start + maxRows);
  const chunks: TextChunk[] = [];
  const plain: string[] = [];
  for (const [offset, target] of visible.entries()) {
    const index = start + offset;
    if (offset > 0) chunks.push(fg(ramp.foreground)("\n"));
    const selected = index === state.selectedIndex;
    const prefix = selected ? "> " : "  ";
    plain.push(
      `${prefix}${target.name}${target.disabledReason ? `  ${target.disabledReason}` : ""}`,
    );
    chunks.push(fg(selected ? ramp.focus : ramp.dim)(prefix));
    if (selected) chunks.push(bold(fg(ramp.foreground)(target.name)));
    else chunks.push(fg(ramp.secondary)(target.name));
    if (target.disabledReason) {
      chunks.push(fg(ramp.dim)(`  ${target.disabledReason}`));
    }
  }
  return { styled: new StyledText(chunks), plain };
}

export function pickerModalWidth(rows: readonly string[], viewportWidth: number): number {
  const widest = Math.max(PICKER_TITLE.length, ...rows.map((row) => row.length));
  const horizontalFrameCells = PICKER_BORDER_CELLS_X + 2 * FXNK_MODAL_PADDING_X;
  return Math.max(
    1,
    Math.min(PICKER_MAX_WIDTH, Math.max(28, widest + horizontalFrameCells), viewportWidth - 2),
  );
}

function pickerWindowStart(length: number, selectedIndex: number, maxRows: number): number {
  if (length <= maxRows) return 0;
  const centered = selectedIndex < 0 ? 0 : selectedIndex - Math.floor(maxRows / 2);
  return Math.max(0, Math.min(length - maxRows, centered));
}

function isBrowserPickerKey(key: KeyEvent): boolean {
  const name = key.name.toLowerCase();
  const bKey = name === "b" || key.baseCode === "b".codePointAt(0);
  return bKey && key.ctrl && key.shift && !key.option && !key.meta && !key.super && !key.hyper;
}

function isCtrlC(key: KeyEvent): boolean {
  const name = key.name.toLowerCase();
  return (
    (name === "c" || key.baseCode === "c".codePointAt(0)) &&
    key.ctrl &&
    !key.shift &&
    !key.meta &&
    !key.option &&
    !key.super &&
    !key.hyper
  );
}

function ownKey(key: KeyEvent): void {
  key.preventDefault();
  key.stopPropagation();
}

if (import.meta.main) {
  const renderer = new CliRenderer(
    process.stdin,
    process.stdout,
    process.stdout.columns || 80,
    process.stdout.rows || 24,
    {
      exitOnCtrlC: false,
      targetFps: 15,
      maxFps: 30,
      useKittyKeyboard: {
        disambiguate: true,
        alternateKeys: true,
        events: true,
        allKeysAsEscapes: true,
        reportText: true,
      },
    },
  );
  const themePort = {
    write: (sequence: string) => process.stdout.write(sequence),
    subscribeOsc: (handler: (sequence: string) => void) => renderer.subscribeOsc(handler),
    prependInputHandler: (handler: (sequence: string) => boolean) =>
      renderer.prependInputHandler(handler),
    removeInputHandler: (handler: (sequence: string) => boolean) =>
      renderer.removeInputHandler(handler),
  };
  let resolution = await resolveFxnkTheme(themePort);
  let app: OpenTuiBrowserApp | null = null;
  const themeMonitor = new FxnkThemeMonitor(themePort, resolution, (next) => {
    resolution = next;
    app?.setTheme(next.theme);
  });
  themeMonitor.start();
  renderer.once(CliRenderEvents.DESTROY, () => themeMonitor.dispose());
  try {
    await renderer.setupTerminal();
    app = new OpenTuiBrowserApp(renderer, resolution.theme);
    app.start();
  } catch (error) {
    themeMonitor.dispose();
    renderer.destroy();
    throw error;
  }
}
