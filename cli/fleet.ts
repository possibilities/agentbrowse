import { CliError } from "./errors.ts";
import type {
  BrowserFarm,
  BrowserListEntry,
  CreateOptions,
  CreateResult,
  DestroyResult,
  ProvisionOptions,
} from "./farm.ts";
import { validateName } from "./model.ts";

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

  constructor(readonly farms: readonly BrowserFarm[]) {
    this.farmById = new Map(farms.map((farm) => [farm.backend.id, farm]));
  }

  async create(options: CreateOptions): Promise<CreateResult> {
    const bound = await this.boundFarm(options.name);
    if (bound !== undefined) {
      await bound.probeAvailability();
      return await bound.create(options, true);
    }
    return await this.selectForMutation((farm) => farm.create(options, true));
  }

  async provision(options: ProvisionOptions): Promise<CreateResult> {
    const bound = await this.boundFarm(options.name);
    if (bound !== undefined) {
      await bound.probeAvailability();
      return await bound.provision(options, true);
    }
    return await this.selectForMutation((farm) => farm.provision(options, true));
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

  async destroy(name: string, backendId?: string): Promise<DestroyResult> {
    validateName(name);
    const explicit = backendId === undefined ? undefined : this.requireFarm(backendId);
    const bound = explicit ?? (await this.boundFarm(name));
    if (bound !== undefined) {
      await bound.probeAvailability();
      return await bound.destroy(name, true);
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
      if (match !== undefined) return await farm.destroy(name, true);
    }
    if (outcomes.length === this.farms.length && this.farms.length > 0) {
      throw unavailableSet(outcomes);
    }
    const firstAvailable = this.farms.find(
      (farm) => !outcomes.some((outcome) => outcome.backend === farm.backend.id),
    );
    if (firstAvailable === undefined) throw noBackendsConfigured();
    return await firstAvailable.destroy(name, true);
  }

  private async selectForMutation(
    operation: (farm: BrowserFarm) => Promise<CreateResult>,
  ): Promise<CreateResult> {
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
      // have found an existing target or mutated state, so selection never resumes.
      return await operation(farm);
    }
    throw unavailableSet(outcomes);
  }

  private async boundFarm(name: string): Promise<BrowserFarm | undefined> {
    for (const farm of this.farms) {
      const receipt = await farm.readTarget(name);
      if (receipt !== undefined) return this.requireFarm(receipt.backend);
    }
    return undefined;
  }

  private requireFarm(id: string): BrowserFarm {
    const farm = this.farmById.get(id);
    if (farm === undefined) {
      throw new CliError(
        "unknown_backend",
        `target receipt names backend ${id}, which is not configured`,
      );
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
