import { tmpdir } from "node:os";
import { join } from "node:path";

import { CliError } from "./errors.ts";
import type {
  BrowserFarm,
  BrowserListEntry,
  CreateOptions,
  CreateResult,
  DestroyResult,
  ProfileCreateResult,
  ProfileDeleteResult,
  ProfileListEntry,
  ProvisionOptions,
} from "./farm.ts";
import { validateName } from "./model.ts";
import { ProfileBindingStore } from "./profile-binding.ts";

const AVAILABILITY_CODES = new Set([
  "browser_host_unresolved",
  "browser_host_unreachable",
  "browser_host_not_accepting_connections",
  "browser_service_unavailable",
  "apple_service_stopped",
]);

interface AvailabilityOutcome {
  readonly backend: string;
  readonly error: CliError;
}

export class BrowserFleet {
  private readonly farmById: ReadonlyMap<string, BrowserFarm>;
  readonly bindings: ProfileBindingStore;

  constructor(
    readonly farms: readonly BrowserFarm[],
    stateDir = join(farms[0]?.runtimeDir ?? tmpdir(), "profile-bindings"),
  ) {
    this.farmById = new Map(farms.map((farm) => [farm.backend.id, farm]));
    this.bindings = new ProfileBindingStore(stateDir);
  }

  async create(options: CreateOptions): Promise<CreateResult> {
    const profile = options.profile ?? options.name;
    validateName(profile);
    const [targetFarm, binding] = await Promise.all([
      this.boundFarmForTarget(options.name),
      this.bindings.read(profile),
    ]);
    const profileFarm = binding === undefined ? undefined : this.requireFarm(binding.backend);
    if (targetFarm !== undefined && profileFarm !== undefined && targetFarm !== profileFarm) {
      throw new CliError(
        "target_profile_backend_mismatch",
        `Browser target ${options.name} and profile ${profile} are bound to different backends`,
        "destroy the stale target without deleting its profile, then retry",
      );
    }
    const bound = targetFarm ?? profileFarm;
    if (bound !== undefined) {
      await bound.probeAvailability();
      return await this.createAndBind(bound, options);
    }
    return await this.selectForMutation(async (farm) => await this.createAndBind(farm, options));
  }

  async provisionProfile(options: ProvisionOptions): Promise<CreateResult> {
    validateName(options.profile);
    const binding = await this.bindings.read(options.profile);
    if (binding !== undefined) {
      const farm = this.requireFarm(binding.backend);
      await farm.probeAvailability();
      return await this.provisionAndBind(farm, options);
    }
    return await this.selectForMutation(async (farm) => await this.provisionAndBind(farm, options));
  }

  async list(signal?: AbortSignal): Promise<readonly BrowserListEntry[]> {
    const outcomes: AvailabilityOutcome[] = [];
    const rows: BrowserListEntry[] = [];
    let available = 0;
    for (const farm of this.farms) {
      signal?.throwIfAborted();
      try {
        await farm.probeAvailability(signal);
      } catch (error) {
        if (!isAvailabilityFailure(error)) throw error;
        outcomes.push({ backend: farm.backend.id, error });
        continue;
      }
      available += 1;
      rows.push(...(await farm.list(signal, true)));
    }
    if (available === 0 && this.farms.length > 0) throw unavailableSet(outcomes);
    return rows.sort(
      (left, right) =>
        left.slot - right.slot ||
        left.backend.localeCompare(right.backend) ||
        left.name.localeCompare(right.name),
    );
  }

  async targetForProfile(
    profile: string,
    signal?: AbortSignal,
  ): Promise<BrowserListEntry | undefined> {
    validateName(profile);
    const binding = await this.bindings.read(profile);
    if (binding?.target === null || binding === undefined) return undefined;
    const farm = this.requireFarm(binding.backend);
    await farm.probeAvailability(signal);
    return await farm.targetFromBinding(binding.target, signal);
  }

  async createProfile(name: string): Promise<ProfileCreateResult> {
    validateName(name);
    const binding = await this.bindings.read(name);
    if (binding !== undefined) {
      const farm = this.requireFarm(binding.backend);
      await farm.probeAvailability();
      return await farm.createProfile(name, true);
    }
    return await this.selectForMutation(async (farm) => {
      await this.bindProfile(name, farm.backend.id);
      const result = await farm.createProfile(name, true);
      return result;
    });
  }

  async listProfiles(signal?: AbortSignal): Promise<readonly ProfileListEntry[]> {
    const outcomes: AvailabilityOutcome[] = [];
    const rows: ProfileListEntry[] = [];
    let available = 0;
    for (const farm of this.farms) {
      signal?.throwIfAborted();
      try {
        await farm.probeAvailability(signal);
      } catch (error) {
        if (!isAvailabilityFailure(error)) throw error;
        outcomes.push({ backend: farm.backend.id, error });
        continue;
      }
      available += 1;
      rows.push(...(await farm.listProfiles(signal, true)));
    }
    if (available === 0 && this.farms.length > 0) throw unavailableSet(outcomes);
    return rows.sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.backend.localeCompare(right.backend),
    );
  }

  async deleteProfile(name: string): Promise<ProfileDeleteResult> {
    validateName(name);
    const binding = await this.bindings.read(name);
    if (binding !== undefined) {
      const farm = this.requireFarm(binding.backend);
      await farm.probeAvailability();
      const result = await farm.deleteProfile(name, true);
      await this.bindings.delete(name, binding.backend);
      return result;
    }

    const matches = (await this.listProfiles()).filter((profile) => profile.name === name);
    if (matches.length > 1) {
      throw new CliError(
        "profile_backend_conflict",
        `Browser profile ${name} exists on more than one backend without a binding receipt`,
        "inspect each backend and delete only the stale profile",
      );
    }
    if (matches.length === 1) {
      const farm = this.requireFarm(matches[0]!.backend);
      return await farm.deleteProfile(name, true);
    }
    return await this.selectForMutation(async (farm) => await farm.deleteProfile(name, true));
  }

  async destroy(name: string, backendId?: string, profileHint?: string): Promise<DestroyResult> {
    validateName(name);
    if (profileHint !== undefined) validateName(profileHint);
    const explicit = backendId === undefined ? undefined : this.requireFarm(backendId);
    const targetBound = explicit ?? (await this.boundFarmForTarget(name));
    const profileBinding =
      profileHint === undefined ? undefined : await this.bindings.read(profileHint);
    const currentBound =
      profileBinding?.target?.name === name ? this.requireFarm(profileBinding.backend) : undefined;
    const bound = targetBound ?? currentBound;
    if (bound !== undefined) {
      await bound.probeAvailability();
      const result = await bound.destroy(name, true);
      await this.clearDestroyedTarget(result, profileHint);
      return result;
    }

    const outcomes: AvailabilityOutcome[] = [];
    for (const farm of this.farms) {
      try {
        await farm.probeAvailability();
      } catch (error) {
        if (!isAvailabilityFailure(error)) throw error;
        outcomes.push({ backend: farm.backend.id, error });
        continue;
      }
      const match = (await farm.list(undefined, true)).find((target) => target.name === name);
      if (match !== undefined) {
        const result = await farm.destroy(name, true);
        await this.clearDestroyedTarget(result, profileHint);
        return result;
      }
    }
    if (outcomes.length === this.farms.length && this.farms.length > 0) {
      throw unavailableSet(outcomes);
    }
    const firstAvailable = this.farms.find(
      (farm) => !outcomes.some((outcome) => outcome.backend === farm.backend.id),
    );
    if (firstAvailable === undefined) throw noBackendsConfigured();
    const result = await firstAvailable.destroy(name, true);
    await this.clearDestroyedTarget(result, profileHint);
    return result;
  }

  private async createAndBind(farm: BrowserFarm, options: CreateOptions): Promise<CreateResult> {
    await this.bindProfile(options.profile ?? options.name, farm.backend.id);
    const result = await farm.create(options, true);
    await this.bindTarget(result);
    return result;
  }

  private async provisionAndBind(
    farm: BrowserFarm,
    options: ProvisionOptions,
  ): Promise<CreateResult> {
    await this.bindProfile(options.profile, farm.backend.id);
    const result = await farm.provisionProfile(options, true);
    await this.bindTarget(result);
    return result;
  }

  private async bindTarget(result: CreateResult): Promise<void> {
    try {
      await this.bindings.bindTarget(result);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "profile_binding_failed",
        `${result.container} is ready but its durable profile binding failed: ${(error as Error).message}`,
        `inspect ${result.container} on ${result.backend}, then retry the same session`,
      );
    }
  }

  private async bindProfile(profile: string, backend: string): Promise<void> {
    try {
      await this.bindings.bindProfile(profile, backend);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError(
        "profile_binding_failed",
        `Browser profile ${profile} exists on ${backend} but its durable binding failed: ${(error as Error).message}`,
      );
    }
  }

  private async clearDestroyedTarget(result: DestroyResult, profileHint?: string): Promise<void> {
    const profile = profileHint ?? result.profile;
    if (profile === null || profile === undefined) return;
    await this.bindings.clearTarget({ ...result, profile });
  }

  private async selectForMutation<T>(operation: (farm: BrowserFarm) => Promise<T>): Promise<T> {
    if (this.farms.length === 0) throw noBackendsConfigured();
    const outcomes: AvailabilityOutcome[] = [];
    for (const farm of this.farms) {
      try {
        await farm.probeAvailability();
      } catch (error) {
        if (!isAvailabilityFailure(error)) throw error;
        outcomes.push({ backend: farm.backend.id, error });
        continue;
      }
      // Any error after a successful probe surfaces immediately. The backend may
      // have found existing state or mutated resources, so selection never resumes.
      return await operation(farm);
    }
    throw unavailableSet(outcomes);
  }

  private async boundFarmForTarget(name: string): Promise<BrowserFarm | undefined> {
    for (const farm of this.farms) {
      const receipt = await farm.readTarget(name);
      if (receipt !== undefined) return this.requireFarm(receipt.backend);
    }
    return undefined;
  }

  private requireFarm(id: string): BrowserFarm {
    const farm = this.farmById.get(id);
    if (farm === undefined) {
      throw new CliError("unknown_backend", `receipt names backend ${id}, which is not configured`);
    }
    return farm;
  }
}

export function isAvailabilityFailure(error: unknown): error is CliError {
  return error instanceof CliError && AVAILABILITY_CODES.has(error.code);
}

function unavailableSet(outcomes: readonly AvailabilityOutcome[]): CliError {
  const summary = outcomes.map(({ backend, error }) => `${backend}: ${error.message}`).join("; ");
  const recovery = outcomes
    .map(({ backend, error }) =>
      error.recovery === undefined ? null : `${backend}: ${error.recovery}`,
    )
    .filter((value): value is string => value !== null)
    .join("; ");
  return new CliError(
    "no_backend_available",
    `no Browser backend is available (${summary})`,
    recovery === "" ? undefined : recovery,
  );
}

function noBackendsConfigured(): CliError {
  return new CliError(
    "browser_backends_not_configured",
    "no Browser backends are configured",
    "install the version 2 agentbrowse deployment configuration",
  );
}
