import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type {
  ContainerState,
  FarmBackend,
  ManagedContainerRecord,
  ManagedProfileRecord,
  PortBinding,
  ProfileState,
} from "./backend.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserDescription,
  type BrowserProfile,
  CHROMIUM_FLAGS,
  configPath,
  incarnatedTargetName,
  PROFILE_MOUNT_PATH,
  PROFILE_SCHEMA_VERSION,
  parseTargetConfig,
  profileFor,
  renderTargetConfig,
  type Target,
  targetFor,
  validateName,
} from "./model.ts";

export interface CreateOptions {
  name: string;
  profile?: string;
  slot: number;
  image?: string;
  readyTimeoutSeconds?: number;
}

export interface ProvisionOptions {
  profile: string;
  image?: string;
}

export interface CreateResult extends BrowserDescription {
  created: boolean;
}

export interface DestroyResult {
  name: string;
  profile: string | null;
  container: string;
  destroyed: boolean;
}

export interface ProfileCreateResult extends BrowserProfile {
  created: boolean;
}

export interface ProfileDeleteResult extends BrowserProfile {
  deleted: boolean;
}

export interface ProfileListEntry extends ManagedProfileRecord {
  consumers: readonly string[];
}

export interface BrowserListEntry extends ManagedContainerRecord {
  cdpUrl: string;
  liveViewUrl: string;
  slotConflict: boolean;
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

function hasProfileMount(state: ContainerState, profile: BrowserProfile): boolean {
  return state.mounts.some(
    (mount) =>
      mount.type === "volume" &&
      mount.name === profile.volume &&
      mount.destination === PROFILE_MOUNT_PATH &&
      mount.writable,
  );
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
  networkAddress: string,
): void {
  const profile = profileFor(target.profile);
  if (state.labels["dev.agentbrowse.managed"] !== "true") {
    drift(`${target.container} is not managed by agentbrowse`);
  }
  if (state.labels["dev.agentbrowse.role"] !== "kernel-browser") {
    drift(`${target.container} has a different agentbrowse role`);
  }
  if (state.labels["dev.agentbrowse.target"] !== target.name) {
    drift(`${target.container} belongs to a different browser target`);
  }
  if (state.labels["dev.agentbrowse.profile"] !== profile.name) {
    drift(`${target.container} uses a different browser profile`);
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
  if (!hasEnvironment(state, `NEKO_WEBRTC_NAT1TO1=${networkAddress}`)) {
    drift(`${target.container} uses a different WebRTC NAT address`);
  }
  if (!hasBinding(state, "8080/tcp", "127.0.0.1", target.httpPort)) {
    drift(`${target.container} uses a different Live View HTTP bind`);
  }
  if (!hasBinding(state, `${target.webrtcPort}/udp`, networkAddress, target.webrtcPort)) {
    drift(`${target.container} uses a different WebRTC bind`);
  }
  if (!hasBinding(state, "9222/tcp", networkAddress, target.cdpPort)) {
    drift(`${target.container} uses a different CDP bind`);
  }
  if (!hasProfileMount(state, profile)) {
    drift(`${target.container} does not have the expected writable browser profile mount`);
  }
}

function verifyManagedProfile(state: ProfileState, profile: BrowserProfile): void {
  if (
    state.volume !== profile.volume ||
    state.labels["dev.agentbrowse.managed"] !== "true" ||
    state.labels["dev.agentbrowse.role"] !== "browser-profile" ||
    state.labels["dev.agentbrowse.profile"] !== profile.name ||
    state.labels["dev.agentbrowse.profile.schema"] !== String(PROFILE_SCHEMA_VERSION)
  ) {
    throw new CliError(
      "profile_drift",
      `${profile.volume} is not the expected agentbrowse browser profile`,
      "choose another profile name or inspect the exact Docker volume before changing it",
    );
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
  const profile = state.labels["dev.agentbrowse.profile"] ?? name;
  return targetFor(name, Number(slot), profile);
}

export class BrowserFarm {
  constructor(
    readonly backend: FarmBackend,
    readonly runtimeDir: string,
    readonly nekoLogLevel = "info",
    readonly targetToken: TargetTokenFactory = defaultTargetToken,
  ) {}

  async create(options: CreateOptions): Promise<CreateResult> {
    const result = await this.withAllocationLock(async () => await this.prepareCreate(options));
    return await this.waitForCreate(result, options.readyTimeoutSeconds ?? 120);
  }

  async provisionProfile(options: ProvisionOptions): Promise<CreateResult> {
    const result = await this.withAllocationLock(async () => {
      validateName(options.profile);
      await this.backend.verifyHost();
      const managed = await this.backend.listManagedContainers();
      const profileTargets = managed.filter((browser) => browser.profile === options.profile);
      if (profileTargets.length > 1) {
        throw new CliError(
          "profile_conflict",
          `browser profile ${options.profile} is bound to more than one Browser target`,
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
      );
    });
    return await this.waitForCreate(result, PROVIDER_READY_TIMEOUT_SECONDS);
  }

  private async prepareCreate(
    options: CreateOptions,
    knownManaged?: readonly ManagedContainerRecord[],
  ): Promise<CreateResult> {
    const target = targetFor(options.name, options.slot, options.profile ?? options.name);
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
    const profileHolder = managed.find(
      (browser) => browser.profile === target.profile && browser.container !== target.container,
    );
    if (profileHolder !== undefined) {
      throw new CliError(
        "profile_in_use",
        `browser profile ${target.profile} is already bound to Browser target ${profileHolder.name} (${profileHolder.state})`,
        `destroy Browser target ${profileHolder.name} before reusing the profile`,
      );
    }
    const profile = profileFor(target.profile);
    await this.ensureProfile(profile);
    await this.verifyExclusiveProfileConsumer(profile, target.container);
    const [networkAddress, image] = await Promise.all([
      this.backend.resolveNetworkAddress(),
      this.backend.resolveImage(options.image),
    ]);
    const existing = await this.backend.inspectContainer(target.container);
    let created = false;
    if (existing !== undefined) {
      verifyManagedContainer(existing, target, image, networkAddress);
      if (!existing.running) await this.backend.startContainer(target.container);
    } else {
      if (!(await this.backend.imageExists(image))) {
        throw new CliError(
          "image_missing",
          `image ${image} is not present on the browser host`,
          "build or load the Kernel image, or select one with --image",
        );
      }
      await this.backend.runBrowser({
        target,
        profile,
        image,
        networkAddress,
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
          `inspect ${target.container} logs on the configured browser host, then run agentbrowse destroy ${target.name}`,
        );
      }
      throw error;
    }

    return {
      ...target,
      image,
      cdpUrl: `http://${networkAddress}:${target.cdpPort}`,
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
          `inspect ${result.container} logs on the configured browser host, then run agentbrowse destroy ${result.name}`,
        );
      }
      throw error;
    }
    return result;
  }

  async list(signal?: AbortSignal): Promise<readonly BrowserListEntry[]> {
    signal?.throwIfAborted();
    await this.backend.verifyHost(signal);
    const [networkAddress, managed] = await Promise.all([
      this.backend.resolveNetworkAddress(signal),
      this.backend.listManagedContainers(signal),
    ]);
    const slotCounts = new Map<number, number>();
    for (const browser of managed) {
      slotCounts.set(browser.slot, (slotCounts.get(browser.slot) ?? 0) + 1);
    }
    return managed
      .map((browser) => {
        const target = targetFor(browser.name, browser.slot, browser.profile ?? browser.name);
        return {
          ...browser,
          cdpUrl: `http://${networkAddress}:${target.cdpPort}`,
          liveViewUrl: `http://127.0.0.1:${target.httpPort}`,
          slotConflict: (slotCounts.get(browser.slot) ?? 0) > 1,
        };
      })
      .sort((left, right) => left.slot - right.slot || left.name.localeCompare(right.name));
  }

  async targetForProfile(
    name: string,
    signal?: AbortSignal,
  ): Promise<BrowserListEntry | undefined> {
    validateName(name);
    const targets = (await this.list(signal)).filter((browser) => browser.profile === name);
    if (targets.length > 1) {
      throw new CliError(
        "profile_conflict",
        `browser profile ${name} is bound to more than one Browser target`,
        "inspect the conflicting targets and destroy only the stale one",
      );
    }
    return targets[0];
  }

  async createProfile(name: string): Promise<ProfileCreateResult> {
    return await this.withAllocationLock(async () => {
      validateName(name);
      await this.backend.verifyHost();
      const profile = profileFor(name);
      return { ...profile, created: await this.ensureProfile(profile) };
    });
  }

  async listProfiles(signal?: AbortSignal): Promise<readonly ProfileListEntry[]> {
    signal?.throwIfAborted();
    await this.backend.verifyHost(signal);
    const profiles = await this.backend.listManagedProfiles(signal);
    const entries: ProfileListEntry[] = [];
    for (const profile of profiles) {
      signal?.throwIfAborted();
      entries.push({
        ...profile,
        consumers: (await this.backend.listProfileConsumers(profileFor(profile.name), signal))
          .map((consumer) => consumer.container)
          .sort(),
      });
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name));
  }

  async deleteProfile(name: string): Promise<ProfileDeleteResult> {
    return await this.withAllocationLock(async () => {
      validateName(name);
      await this.backend.verifyHost();
      const profile = profileFor(name);
      const state = await this.backend.inspectProfile(profile);
      if (state === undefined) return { ...profile, deleted: false };
      verifyManagedProfile(state, profile);
      const consumers = await this.backend.listProfileConsumers(profile);
      if (consumers.length > 0) {
        throw new CliError(
          "profile_in_use",
          `browser profile ${name} is still mounted by ${consumers.map((entry) => entry.container).join(", ")}`,
          "destroy the exact Browser target before deleting its durable profile",
        );
      }
      await this.backend.removeProfile(profile);
      return { ...profile, deleted: true };
    });
  }

  async destroy(name: string): Promise<DestroyResult> {
    validateName(name);
    return await this.withAllocationLock(async () => {
      await this.backend.verifyHost();
      const recorded = await this.readTarget(name);
      const container = recorded?.container ?? `agentbrowse-browser-${name}`;
      const state = await this.backend.inspectContainer(container);
      if (state === undefined) {
        await this.removeTarget(name);
        return { name, profile: recorded?.profile ?? null, container, destroyed: false };
      }
      const target = recorded ?? targetFromLabels(name, state);
      verifyDestroyOwnership(state, target);
      await this.backend.removeContainer(target.container);
      await this.removeTarget(name);
      return { name, profile: target.profile, container: target.container, destroyed: true };
    });
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
    if (recorded !== undefined && recorded.profile !== target.profile) {
      throw new CliError(
        "target_profile_mismatch",
        `browser target ${target.name} already records profile ${recorded.profile}, not ${target.profile}`,
        `run agentbrowse destroy ${target.name} before choosing another profile`,
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
      "all browser target slots from 0 to 999 are in use",
      "destroy an unused browser target before launching another agent-browser session",
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
      verifyManagedProfile(existing, profile);
      return false;
    }
    await this.backend.createProfile(profile);
    const created = await this.backend.inspectProfile(profile);
    if (created === undefined) {
      throw new CliError(
        "profile_not_ready",
        `browser profile ${profile.name} was not visible after Docker created it`,
      );
    }
    verifyManagedProfile(created, profile);
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
        `browser profile ${profile.name} is already mounted by ${conflicting.container} (${conflicting.state})`,
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
          await writeFile(join(path, "owner"), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
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
