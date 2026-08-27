import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { ContainerState, FarmBackend, PortBinding } from "./backend.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserDescription,
  configPath,
  parseTargetConfig,
  renderTargetConfig,
  type Target,
  targetFor,
  validateName,
} from "./model.ts";

export interface CreateOptions {
  name: string;
  slot: number;
  image?: string;
}

export interface CreateResult extends BrowserDescription {
  created: boolean;
}

export interface DestroyResult {
  name: string;
  container: string;
  destroyed: boolean;
}

function hasBinding(
  state: ContainerState,
  port: string,
  hostIp: string,
  hostPort: number,
): boolean {
  const bindings: readonly PortBinding[] = state.bindings[port] ?? [];
  return bindings.some(
    (binding) => binding.hostIp === hostIp && binding.hostPort === String(hostPort),
  );
}

function hasEnvironment(state: ContainerState, value: string): boolean {
  return state.environment.includes(value);
}

function drift(message: string): never {
  throw new CliError(
    "browser_drift",
    message,
    "destroy the browser target explicitly before recreating it",
  );
}

export function verifyManagedContainer(
  state: ContainerState,
  target: Target,
  image: string,
  tailnetIp: string,
): void {
  if (state.labels["dev.agentbrowse.managed"] !== "true") {
    drift(`${target.container} is not managed by agentbrowse`);
  }
  if (state.labels["dev.agentbrowse.role"] !== "kernel-browser") {
    drift(`${target.container} has a different agentbrowse role`);
  }
  if (state.labels["dev.agentbrowse.target"] !== target.name) {
    drift(`${target.container} belongs to a different browser target`);
  }
  if (state.labels["dev.agentbrowse.slot"] !== String(target.slot)) {
    drift(`${target.container} uses a different slot`);
  }
  if (state.image !== image) drift(`${target.container} uses a different image`);
  if (!hasEnvironment(state, "ENABLE_WEBRTC=true")) {
    drift(`${target.container} does not enable Live View`);
  }
  if (!hasEnvironment(state, `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`)) {
    drift(`${target.container} uses a different WebRTC mux port`);
  }
  if (!hasEnvironment(state, `NEKO_WEBRTC_NAT1TO1=${tailnetIp}`)) {
    drift(`${target.container} uses a different WebRTC NAT address`);
  }
  if (!hasBinding(state, "8080/tcp", "127.0.0.1", target.httpPort)) {
    drift(`${target.container} uses a different Live View HTTP bind`);
  }
  if (!hasBinding(state, `${target.webrtcPort}/udp`, tailnetIp, target.webrtcPort)) {
    drift(`${target.container} uses a different WebRTC bind`);
  }
  if (!hasBinding(state, "9222/tcp", tailnetIp, target.cdpPort)) {
    drift(`${target.container} uses a different CDP bind`);
  }
}

function verifyDestroyOwnership(state: ContainerState, target: Target): void {
  if (
    state.labels["dev.agentbrowse.managed"] !== "true" ||
    state.labels["dev.agentbrowse.role"] !== "kernel-browser" ||
    state.labels["dev.agentbrowse.target"] !== target.name ||
    state.labels["dev.agentbrowse.slot"] !== String(target.slot)
  ) {
    throw new CliError(
      "foreign_container",
      `refusing to delete ${target.container}: its ownership labels do not match ${target.name}`,
    );
  }
}

function targetFromLabels(name: string, state: ContainerState): Target {
  const slot = state.labels["dev.agentbrowse.slot"];
  if (slot === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(slot)) {
    throw new CliError(
      "foreign_container",
      `refusing to delete agentbrowse-browser-${name}: its slot ownership label is invalid`,
    );
  }
  return targetFor(name, Number(slot));
}

export class BrowserFarm {
  constructor(
    readonly backend: FarmBackend,
    readonly runtimeDir: string,
    readonly nekoLogLevel = "info",
  ) {}

  async create(options: CreateOptions): Promise<CreateResult> {
    const target = targetFor(options.name, options.slot);
    await this.verifyRecordedTarget(target);
    await this.backend.verifyHost();
    const [tailnetIp, image] = await Promise.all([
      this.backend.resolveTailnetIp(),
      this.backend.resolveImage(options.image),
    ]);
    const existing = await this.backend.inspectContainer(target.container);
    let created = false;
    if (existing !== undefined) {
      verifyManagedContainer(existing, target, image, tailnetIp);
      if (!existing.running) await this.backend.startContainer(target.container);
    } else {
      if (!(await this.backend.imageExists(image))) {
        throw new CliError(
          "image_missing",
          `image ${image} is not present on Artbird`,
          "build or load the Kernel image, or select one with --image",
        );
      }
      await this.backend.runBrowser({
        target,
        image,
        tailnetIp,
        nekoLogLevel: this.nekoLogLevel,
      });
      created = true;
    }

    try {
      await this.writeTarget(target);
      await this.backend.waitReady(target.container);
    } catch (error) {
      if (created) {
        throw new CliError(
          "browser_not_ready",
          `${target.container} was created but did not become ready: ${(error as Error).message}`,
          `inspect it with docker --context artbird logs ${target.container}, then run agentbrowse destroy ${target.name}`,
        );
      }
      throw error;
    }

    return {
      ...target,
      image,
      cdpUrl: `http://${tailnetIp}:${target.cdpPort}`,
      liveViewUrl: `http://127.0.0.1:${target.httpPort}`,
      created,
    };
  }

  async destroy(name: string): Promise<DestroyResult> {
    validateName(name);
    await this.backend.verifyHost();
    const recorded = await this.readTarget(name);
    const container = recorded?.container ?? `agentbrowse-browser-${name}`;
    const state = await this.backend.inspectContainer(container);
    if (state === undefined) {
      await this.removeTarget(name);
      return { name, container, destroyed: false };
    }
    const target = recorded ?? targetFromLabels(name, state);
    verifyDestroyOwnership(state, target);
    await this.backend.removeContainer(target.container);
    await this.removeTarget(name);
    return { name, container: target.container, destroyed: true };
  }

  private async verifyRecordedTarget(target: Target): Promise<void> {
    const recorded = await this.readTarget(target.name);
    if (recorded !== undefined && recorded.slot !== target.slot) {
      throw new CliError(
        "target_slot_mismatch",
        `browser target ${target.name} already records slot ${recorded.slot}, not ${target.slot}`,
        `run agentbrowse destroy ${target.name} before choosing another slot`,
      );
    }
  }

  private async readTarget(name: string): Promise<Target | undefined> {
    const path = configPath(this.runtimeDir, name);
    try {
      return parseTargetConfig(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeTarget(target: Target): Promise<void> {
    const path = configPath(this.runtimeDir, target.name);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${path}.tmp-${process.pid}`;
    await writeFile(temporaryPath, renderTargetConfig(target), { mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
  }

  private async removeTarget(name: string): Promise<void> {
    await rm(configPath(this.runtimeDir, name), { force: true });
  }
}
