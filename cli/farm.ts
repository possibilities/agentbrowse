import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ContainerState,
  FarmBackend,
  ManagedContainerRecord,
  PortBinding,
} from "./backend.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserDescription,
  CHROMIUM_FLAGS,
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
  readyTimeoutSeconds?: number;
}

export interface ProvisionOptions {
  name: string;
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

export interface BrowserListEntry extends ManagedContainerRecord {
  cdpUrl: string;
  liveViewUrl: string;
  slotConflict: boolean;
}

const PROVIDER_READY_TIMEOUT_SECONDS = 45;
const PROVIDER_LOCK_WAIT_MS = 10_000;
const PROVIDER_LOCK_STALE_MS = 90_000;

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
  if (!hasEnvironment(state, `CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`)) {
    drift(`${target.container} uses different Chromium window flags`);
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
    const result = await this.prepareCreate(options);
    return await this.waitForCreate(result, options.readyTimeoutSeconds ?? 120);
  }

  async provision(options: ProvisionOptions): Promise<CreateResult> {
    const result = await this.withProviderAllocationLock(async () => {
      validateName(options.name);
      await this.backend.verifyHost();
      const [recorded, managed] = await Promise.all([
        this.readTarget(options.name),
        this.backend.listManagedContainers(),
      ]);
      const existing = managed.find((browser) => browser.name === options.name);
      const usedSlots = new Set(managed.map((browser) => browser.slot));
      const slot = existing?.slot ?? recorded?.slot ?? this.firstFreeSlot(usedSlots);
      return await this.prepareCreate(
        {
          name: options.name,
          slot,
          ...(options.image === undefined ? {} : { image: options.image }),
        },
        managed,
      );
    });
    return await this.waitForCreate(result, PROVIDER_READY_TIMEOUT_SECONDS);
  }

  private async prepareCreate(
    options: CreateOptions,
    knownManaged?: readonly ManagedContainerRecord[],
  ): Promise<CreateResult> {
    const target = targetFor(options.name, options.slot);
    await this.verifyRecordedTarget(target);
    if (knownManaged === undefined) await this.backend.verifyHost();
    const managed = knownManaged ?? (await this.backend.listManagedContainers());
    const occupant = managed.find(
      (browser) => browser.slot === target.slot && browser.container !== target.container,
    );
    if (occupant !== undefined) {
      throw new CliError(
        "slot_in_use",
        `slot ${target.slot} is already used by browser target ${occupant.name} (${occupant.state})`,
        "choose another slot or destroy the occupying browser target",
      );
    }
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

  private async waitForCreate(result: CreateResult, timeoutSeconds: number): Promise<CreateResult> {
    try {
      await this.backend.waitReady(result.container, timeoutSeconds);
    } catch (error) {
      if (result.created) {
        throw new CliError(
          "browser_not_ready",
          `${result.container} was created but did not become ready: ${(error as Error).message}`,
          `inspect it with docker --context artbird logs ${result.container}, then run agentbrowse destroy ${result.name}`,
        );
      }
      throw error;
    }
    return result;
  }

  async list(): Promise<readonly BrowserListEntry[]> {
    await this.backend.verifyHost();
    const [tailnetIp, managed] = await Promise.all([
      this.backend.resolveTailnetIp(),
      this.backend.listManagedContainers(),
    ]);
    const slotCounts = new Map<number, number>();
    for (const browser of managed) {
      slotCounts.set(browser.slot, (slotCounts.get(browser.slot) ?? 0) + 1);
    }
    return managed
      .map((browser) => {
        const target = targetFor(browser.name, browser.slot);
        return {
          ...browser,
          cdpUrl: `http://${tailnetIp}:${target.cdpPort}`,
          liveViewUrl: `http://127.0.0.1:${target.httpPort}`,
          slotConflict: (slotCounts.get(browser.slot) ?? 0) > 1,
        };
      })
      .sort((left, right) => left.slot - right.slot || left.name.localeCompare(right.name));
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

  private firstFreeSlot(usedSlots: ReadonlySet<number>): number {
    for (let slot = 0; slot <= 999; slot += 1) {
      if (!usedSlots.has(slot)) return slot;
    }
    throw new CliError(
      "no_free_slots",
      "all Artbird browser target slots from 0 to 999 are in use",
      "destroy an unused browser target before launching another agent-browser session",
    );
  }

  private async withProviderAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(this.runtimeDir, 0o700);
    const path = join(this.runtimeDir, ".provider-allocation.lock");
    const deadline = Date.now() + PROVIDER_LOCK_WAIT_MS;

    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(path);
          if (Date.now() - details.mtimeMs > PROVIDER_LOCK_STALE_MS) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new CliError(
            "provider_allocation_busy",
            "another Artbird provider launch is still allocating a browser target",
            "retry the agent-browser command",
          );
        }
        await Bun.sleep(50);
      }
    }

    try {
      return await operation();
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  }
}
