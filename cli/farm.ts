import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  type FarmBackend,
  type ManagedContainerRecord,
  type ManagedProfileRecord,
  type ProfileState,
  targetFromLabels,
  verifyDestroyOwnership,
} from "./backend.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserDescription,
  type BrowserProfile,
  configPath,
  incarnatedTargetName,
  PROFILE_SCHEMA_VERSION,
  parseTargetConfig,
  profileFor,
  renderTargetConfig,
  type Target,
  targetFor,
  validateName,
} from "./model.ts";

export interface CreateOptions {
  readonly name: string;
  readonly profile?: string;
  readonly slot: number;
  readonly image?: string;
  readonly readyTimeoutSeconds?: number;
}

export interface ProvisionOptions {
  readonly profile: string;
  readonly image?: string;
}

export interface CreateResult extends BrowserDescription {
  readonly created: boolean;
}

export interface DestroyResult {
  readonly name: string;
  readonly profile: string | null;
  readonly backend: string;
  readonly container: string;
  readonly destroyed: boolean;
}

export interface ProfileCreateResult extends BrowserProfile {
  readonly backend: string;
  readonly created: boolean;
}

export interface ProfileDeleteResult extends BrowserProfile {
  readonly backend: string;
  readonly deleted: boolean;
}

export interface ProfileListEntry extends ManagedProfileRecord {
  readonly backend: string;
  readonly consumers: readonly string[];
}

export interface BrowserListEntry extends ManagedContainerRecord {
  readonly backend: string;
  readonly cdpUrl: string;
  readonly liveViewUrl: string;
  readonly liveViewAccess: BrowserDescription["liveViewAccess"];
  readonly slotConflict: boolean;
}

const PROVIDER_READY_TIMEOUT_SECONDS = 45;
const ALLOCATION_LOCK_WAIT_MS = 10_000;
const ALLOCATION_LOCK_STALE_MS = 90_000;
const TARGET_NAME_ATTEMPTS = 16;

export type TargetTokenFactory = () => string;

function defaultTargetToken(): string {
  return randomBytes(8).toString("hex");
}

async function allocationLockOwnerIsAlive(path: string): Promise<boolean> {
  let source: string;
  try {
    source = await readFile(join(path, "owner"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (!/^[1-9][0-9]*\n$/.test(source)) return false;
  try {
    process.kill(Number(source.trim()), 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}

function verifyManagedProfile(state: ProfileState, profile: BrowserProfile, backend: string): void {
  if (
    state.volume !== profile.volume ||
    state.labels["dev.agentbrowse.managed"] !== "true" ||
    state.labels["dev.agentbrowse.role"] !== "browser-profile" ||
    state.labels["dev.agentbrowse.backend"] !== backend ||
    state.labels["dev.agentbrowse.profile"] !== profile.name ||
    state.labels["dev.agentbrowse.profile.schema"] !== String(PROFILE_SCHEMA_VERSION)
  ) {
    throw new CliError(
      "profile_drift",
      `${profile.volume} is not the expected ${backend} Browser profile`,
      "choose another profile name or inspect the exact backend volume before changing it",
    );
  }
}

export class BrowserFarm {
  constructor(
    readonly backend: FarmBackend,
    readonly runtimeDir: string,
    readonly nekoLogLevel = "info",
    readonly targetToken: TargetTokenFactory = defaultTargetToken,
  ) {}

  async probeAvailability(signal?: AbortSignal): Promise<void> {
    // Docker discovery applies its short backend deadline whenever it receives a
    // signal. Supply an inert signal when the fleet caller did not provide one
    // so ordinary create/provision selection is bounded too.
    await this.backend.verifyHost(signal ?? new AbortController().signal);
  }

  async create(options: CreateOptions, hostVerified = false): Promise<CreateResult> {
    const result = await this.withAllocationLock(
      async () => await this.prepareCreate(options, undefined, hostVerified),
    );
    return await this.waitForCreate(result, options.readyTimeoutSeconds ?? 120);
  }

  async provisionProfile(options: ProvisionOptions, hostVerified = false): Promise<CreateResult> {
    const result = await this.withAllocationLock(async () => {
      validateName(options.profile);
      if (!hostVerified) await this.backend.verifyHost();
      const managed = await this.backend.listManagedContainers();
      const profileTargets = managed.filter((browser) => browser.profile === options.profile);
      if (profileTargets.length > 1) {
        throw new CliError(
          "profile_conflict",
          `Browser profile ${options.profile} is bound to more than one target on ${this.backend.id}`,
          "inspect the conflicting targets and destroy only the stale one",
        );
      }
      const existing = profileTargets[0];
      const usedSlots = new Set(managed.map((browser) => browser.slot));
      const usedNames = new Set(managed.map((browser) => browser.name));
      const name = existing?.name ?? this.nextTargetName(options.profile, usedNames);
      const slot = existing?.slot ?? this.firstFreeSlot(usedSlots);
      return await this.prepareCreate(
        {
          name,
          profile: options.profile,
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
    const profileName = options.profile ?? options.name;
    validateName(profileName);
    if (!hostVerified && knownManaged === undefined) await this.backend.verifyHost();
    const [recorded, managed] = await Promise.all([
      this.readTarget(options.name),
      knownManaged === undefined ? this.backend.listManagedContainers() : knownManaged,
    ]);
    this.verifyReceiptBackend(recorded);
    if (recorded !== undefined && recorded.slot !== options.slot) {
      throw new CliError(
        "target_slot_mismatch",
        `Browser target ${options.name} already records slot ${recorded.slot}, not ${options.slot}`,
        `run agentbrowse destroy ${options.name} before choosing another slot`,
      );
    }
    if (recorded !== undefined && recorded.profile !== profileName) {
      throw new CliError(
        "target_profile_mismatch",
        `Browser target ${options.name} already records profile ${recorded.profile}, not ${profileName}`,
        `run agentbrowse destroy ${options.name} before choosing another profile`,
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
    const target = targetFor(options.name, options.slot, {
      profile: profileName,
      backend: this.backend.id,
      container:
        recorded?.container ??
        existingRecord?.container ??
        this.backend.newContainerName(options.name),
    });
    const occupant = managed.find(
      (browser) => browser.slot === target.slot && browser.container !== target.container,
    );
    if (occupant !== undefined) {
      throw new CliError(
        "slot_in_use",
        `slot ${target.slot} is already used by Browser target ${occupant.name} (${occupant.state})`,
        "choose another slot or destroy the occupying Browser target",
      );
    }
    const profileHolder = managed.find(
      (browser) => browser.profile === target.profile && browser.container !== target.container,
    );
    if (profileHolder !== undefined) {
      throw new CliError(
        "profile_in_use",
        `Browser profile ${target.profile} is already bound to target ${profileHolder.name} (${profileHolder.state})`,
        `destroy Browser target ${profileHolder.name} before reusing the profile`,
      );
    }

    const profile = profileFor(target.profile);
    await this.ensureProfile(profile);
    await this.verifyExclusiveProfileConsumer(profile, target.container);
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
        const target = targetFor(browser.name, browser.slot, {
          profile: browser.profile ?? browser.name,
          backend: this.backend.id,
          container: browser.container,
        });
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

  async targetFromBinding(
    target: Target,
    signal?: AbortSignal,
  ): Promise<BrowserListEntry | undefined> {
    if (target.backend !== this.backend.id) {
      throw new CliError(
        "target_backend_mismatch",
        `Browser target ${target.name} is bound to backend ${target.backend}, not ${this.backend.id}`,
      );
    }
    const matches = (await this.list(signal)).filter(
      (entry) =>
        entry.name === target.name &&
        entry.profile === target.profile &&
        entry.container === target.container,
    );
    if (matches.length > 1) {
      throw new CliError(
        "target_identity_conflict",
        `backend ${this.backend.id} reported Browser target ${target.name} more than once`,
      );
    }
    return matches[0];
  }

  async createProfile(name: string, hostVerified = false): Promise<ProfileCreateResult> {
    return await this.withAllocationLock(async () => {
      validateName(name);
      if (!hostVerified) await this.backend.verifyHost();
      const profile = profileFor(name);
      return {
        ...profile,
        backend: this.backend.id,
        created: await this.ensureProfile(profile),
      };
    });
  }

  async listProfiles(
    signal?: AbortSignal,
    hostVerified = false,
  ): Promise<readonly ProfileListEntry[]> {
    signal?.throwIfAborted();
    if (!hostVerified) await this.backend.verifyHost(signal);
    const profiles = await this.backend.listManagedProfiles(signal);
    const entries: ProfileListEntry[] = [];
    for (const profile of profiles) {
      signal?.throwIfAborted();
      entries.push({
        ...profile,
        backend: this.backend.id,
        consumers: (await this.backend.listProfileConsumers(profileFor(profile.name), signal))
          .map((consumer) => consumer.container)
          .sort(),
      });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async deleteProfile(name: string, hostVerified = false): Promise<ProfileDeleteResult> {
    return await this.withAllocationLock(async () => {
      validateName(name);
      if (!hostVerified) await this.backend.verifyHost();
      const profile = profileFor(name);
      const state = await this.backend.inspectProfile(profile);
      if (state === undefined) {
        return { ...profile, backend: this.backend.id, deleted: false };
      }
      verifyManagedProfile(state, profile, this.backend.id);
      const consumers = await this.backend.listProfileConsumers(profile);
      if (consumers.length > 0) {
        throw new CliError(
          "profile_in_use",
          `Browser profile ${name} is still mounted by ${consumers.map((entry) => entry.container).join(", ")}`,
          "destroy the exact Browser target before deleting its durable profile",
        );
      }
      await this.backend.removeProfile(profile);
      return { ...profile, backend: this.backend.id, deleted: true };
    });
  }

  async destroy(name: string, hostVerified = false): Promise<DestroyResult> {
    validateName(name);
    return await this.withAllocationLock(async () => {
      if (!hostVerified) await this.backend.verifyHost();
      const [recorded, managed] = await Promise.all([
        this.readTarget(name),
        this.backend.listManagedContainers(),
      ]);
      this.verifyReceiptBackend(recorded);
      const discovered = managed.find((record) => record.name === name);
      const container =
        recorded?.container ?? discovered?.container ?? `agentbrowse-browser-${name}`;
      const state = await this.backend.inspectContainer(container);
      if (state === undefined) {
        await this.removeTarget(name);
        return {
          name,
          profile: recorded?.profile ?? discovered?.profile ?? null,
          backend: this.backend.id,
          container,
          destroyed: false,
        };
      }
      const target = recorded ?? targetFromLabels(name, this.backend.id, container, state);
      verifyDestroyOwnership(state, target);
      await this.backend.removeContainer(target.container);
      await this.removeTarget(name);
      return {
        name,
        profile: target.profile,
        backend: this.backend.id,
        container: target.container,
        destroyed: true,
      };
    });
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
        `Browser target ${recorded.name} is bound to backend ${recorded.backend}, not ${this.backend.id}`,
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
      "all Browser target slots from 0 to 999 are in use",
      "destroy an unused Browser target before launching another agent-browser session",
    );
  }

  private nextTargetName(profile: string, usedNames: ReadonlySet<string>): string {
    for (let attempt = 0; attempt < TARGET_NAME_ATTEMPTS; attempt += 1) {
      const name = incarnatedTargetName(profile, this.targetToken());
      if (!usedNames.has(name)) return name;
    }
    throw new CliError(
      "target_name_unavailable",
      `could not allocate a fresh Browser target name for profile ${profile}`,
      "retry the agent-browser command",
    );
  }

  private async ensureProfile(profile: BrowserProfile): Promise<boolean> {
    const existing = await this.backend.inspectProfile(profile);
    if (existing !== undefined) {
      verifyManagedProfile(existing, profile, this.backend.id);
      return false;
    }
    await this.backend.createProfile(profile);
    const created = await this.backend.inspectProfile(profile);
    if (created === undefined) {
      throw new CliError(
        "profile_not_ready",
        `Browser profile ${profile.name} was not visible after backend ${this.backend.id} created it`,
      );
    }
    verifyManagedProfile(created, profile, this.backend.id);
    return true;
  }

  private async verifyExclusiveProfileConsumer(
    profile: BrowserProfile,
    expectedContainer: string,
  ): Promise<void> {
    const consumers = await this.backend.listProfileConsumers(profile);
    const conflicting = consumers.find((consumer) => consumer.container !== expectedContainer);
    if (conflicting !== undefined) {
      throw new CliError(
        "profile_in_use",
        `Browser profile ${profile.name} is already mounted by ${conflicting.container} (${conflicting.state})`,
        "destroy or inspect that exact container before reusing the profile",
      );
    }
  }

  private async withAllocationLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.runtimeDir, { recursive: true, mode: 0o700 });
    await chmod(this.runtimeDir, 0o700);
    const path = join(this.runtimeDir, ".allocation.lock");
    const deadline = Date.now() + ALLOCATION_LOCK_WAIT_MS;

    while (true) {
      try {
        await mkdir(path, { mode: 0o700 });
        try {
          await writeFile(join(path, "owner"), `${process.pid}\n`, {
            flag: "wx",
            mode: 0o600,
          });
        } catch (error) {
          await rm(path, { recursive: true, force: true });
          throw error;
        }
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        try {
          const details = await stat(path);
          if (
            Date.now() - details.mtimeMs > ALLOCATION_LOCK_STALE_MS &&
            !(await allocationLockOwnerIsAlive(path))
          ) {
            await rm(path, { recursive: true, force: true });
            continue;
          }
        } catch (lockError) {
          if ((lockError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw lockError;
        }
        if (Date.now() >= deadline) {
          throw new CliError(
            "allocation_busy",
            "another Browser target or profile lifecycle operation is still running",
            "retry the agentbrowse or agent-browser command",
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
