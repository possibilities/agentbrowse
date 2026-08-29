import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type FarmBackend,
  type ManagedContainerRecord,
  targetFromLabels,
  verifyDestroyOwnership,
} from "./backend.ts";
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
  backend: string;
  container: string;
  destroyed: boolean;
}

export interface BrowserListEntry extends ManagedContainerRecord {
  backend: string;
  cdpUrl: string;
  liveViewUrl: string;
  liveViewAccess: BrowserDescription["liveViewAccess"];
  slotConflict: boolean;
}

const PROVIDER_READY_TIMEOUT_SECONDS = 45;
const PROVIDER_LOCK_WAIT_MS = 10_000;
const PROVIDER_LOCK_STALE_MS = 90_000;

export class BrowserFarm {
  constructor(
    readonly backend: FarmBackend,
    readonly runtimeDir: string,
    readonly nekoLogLevel = "info",
  ) {}

  async probeAvailability(signal?: AbortSignal): Promise<void> {
    // Docker discovery applies its short backend deadline whenever it receives a
    // signal. Supply an inert signal when the fleet caller did not provide one
    // so ordinary create/provision selection is bounded too.
    await this.backend.verifyHost(signal ?? new AbortController().signal);
  }

  async create(options: CreateOptions, hostVerified = false): Promise<CreateResult> {
    const result = await this.prepareCreate(options, undefined, hostVerified);
    return await this.waitForCreate(result, options.readyTimeoutSeconds ?? 120);
  }

  async provision(options: ProvisionOptions, hostVerified = false): Promise<CreateResult> {
    const result = await this.withProviderAllocationLock(async () => {
      validateName(options.name);
      if (!hostVerified) await this.backend.verifyHost();
      const [recorded, managed] = await Promise.all([
        this.readTarget(options.name),
        this.backend.listManagedContainers(),
      ]);
      this.verifyReceiptBackend(recorded);
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
        true,
      );
    });
    return await this.waitForCreate(result, PROVIDER_READY_TIMEOUT_SECONDS);
  }

  private async prepareCreate(
    options: CreateOptions,
    knownManaged?: readonly ManagedContainerRecord[],
    hostVerified = false,
  ): Promise<CreateResult> {
    validateName(options.name);
    if (!hostVerified && knownManaged === undefined) await this.backend.verifyHost();
    const [recorded, managed] = await Promise.all([
      this.readTarget(options.name),
      knownManaged === undefined ? this.backend.listManagedContainers() : knownManaged,
    ]);
    this.verifyReceiptBackend(recorded);
    if (recorded !== undefined && recorded.slot !== options.slot) {
      throw new CliError(
        "target_slot_mismatch",
        `browser target ${options.name} already records slot ${recorded.slot}, not ${options.slot}`,
        `run agentbrowse destroy ${options.name} before choosing another slot`,
      );
    }
    const existingRecord = managed.find((browser) => browser.name === options.name);
    if (
      existingRecord === undefined &&
      recorded === undefined &&
      managed.length >= this.backend.maxTargets
    ) {
      throw new CliError(
        "backend_capacity_exhausted",
        `backend ${this.backend.id} already has its maximum ${this.backend.maxTargets} Browser target${this.backend.maxTargets === 1 ? "" : "s"}`,
        "destroy the existing Browser target before launching another",
      );
    }
    const target = targetFor(
      options.name,
      options.slot,
      this.backend.id,
      recorded?.container ??
        existingRecord?.container ??
        this.backend.newContainerName(options.name),
    );
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
    const image = await this.backend.resolveImage(options.image);
    let state = await this.backend.inspectContainer(target.container);
    let created = false;
    if (state !== undefined) {
      await this.backend.verifyContainer(state, target, image);
      if (!state.running) {
        await this.backend.startContainer(target.container);
        state = await this.backend.inspectContainer(target.container);
      }
    } else {
      if (!(await this.backend.imageExists(image))) {
        throw new CliError(
          "image_missing",
          `image ${image} is not present on backend ${this.backend.id}`,
          this.backend.missingImageRecovery(image),
        );
      }
      await this.backend.runBrowser({ target, image, nekoLogLevel: this.nekoLogLevel });
      created = true;
    }

    try {
      await this.writeTarget(target);
    } catch (error) {
      if (created) {
        throw new CliError(
          "target_receipt_failed",
          `${target.container} was created but its backend-bound receipt failed: ${(error as Error).message}`,
          `inspect ${target.container} on backend ${target.backend}, then run agentbrowse destroy ${target.name}`,
        );
      }
      throw error;
    }

    state ??= await this.backend.inspectContainer(target.container);
    if (state === undefined) {
      throw new CliError(
        "target_inspect_failed",
        `${target.container} was created but is absent during post-create inspection`,
        `inspect backend ${target.backend}, then run agentbrowse destroy ${target.name}`,
      );
    }
    const access = await this.backend.browserAccess(target, state);
    return { ...target, image, ...access, created };
  }

  private async waitForCreate(result: CreateResult, timeoutSeconds: number): Promise<CreateResult> {
    try {
      await this.backend.waitReady(result, timeoutSeconds);
    } catch (error) {
      if (result.created) {
        throw new CliError(
          "browser_not_ready",
          `${result.container} was created but did not become ready: ${(error as Error).message}`,
          `inspect ${result.container} on backend ${result.backend}, then run agentbrowse destroy ${result.name}`,
        );
      }
      throw error;
    }
    return result;
  }

  async list(signal?: AbortSignal, hostVerified = false): Promise<readonly BrowserListEntry[]> {
    signal?.throwIfAborted();
    if (!hostVerified) await this.backend.verifyHost(signal);
    const managed = await this.backend.listManagedContainers(signal);
    const slotCounts = new Map<number, number>();
    for (const browser of managed) {
      slotCounts.set(browser.slot, (slotCounts.get(browser.slot) ?? 0) + 1);
    }
    const rows = await Promise.all(
      managed.map(async (browser) => {
        const target = targetFor(browser.name, browser.slot, this.backend.id, browser.container);
        const access = await this.backend.browserAccess(target);
        return {
          ...browser,
          backend: this.backend.id,
          ...access,
          slotConflict: (slotCounts.get(browser.slot) ?? 0) > 1,
        };
      }),
    );
    return rows.sort(
      (left, right) => left.slot - right.slot || left.name.localeCompare(right.name),
    );
  }

  async destroy(name: string, hostVerified = false): Promise<DestroyResult> {
    validateName(name);
    if (!hostVerified) await this.backend.verifyHost();
    const [recorded, managed] = await Promise.all([
      this.readTarget(name),
      this.backend.listManagedContainers(),
    ]);
    this.verifyReceiptBackend(recorded);
    const discovered = managed.find((record) => record.name === name);
    const container = recorded?.container ?? discovered?.container ?? `agentbrowse-browser-${name}`;
    const state = await this.backend.inspectContainer(container);
    if (state === undefined) {
      await this.removeTarget(name);
      return { name, backend: this.backend.id, container, destroyed: false };
    }
    const target = recorded ?? targetFromLabels(name, this.backend.id, container, state);
    verifyDestroyOwnership(state, target);
    await this.backend.removeContainer(target.container);
    await this.removeTarget(name);
    return { name, backend: this.backend.id, container: target.container, destroyed: true };
  }

  async readTarget(name: string): Promise<Target | undefined> {
    const path = configPath(this.runtimeDir, name);
    try {
      return parseTargetConfig(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private verifyReceiptBackend(recorded: Target | undefined): void {
    if (recorded !== undefined && recorded.backend !== this.backend.id) {
      throw new CliError(
        "target_backend_mismatch",
        `browser target ${recorded.name} is bound to backend ${recorded.backend}, not ${this.backend.id}`,
      );
    }
  }

  private async writeTarget(target: Target): Promise<void> {
    const path = configPath(this.runtimeDir, target.name);
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const temporaryPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temporaryPath, renderTargetConfig(target), { mode: 0o600, flag: "wx" });
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporaryPath, { force: true });
    }
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
      "all browser target slots from 0 to 999 are in use",
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
            "another provider launch is still allocating a browser target",
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
