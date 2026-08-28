import { CliError } from "./errors.ts";
import type { BrowserFarm, BrowserListEntry } from "./farm.ts";
import { providerProfileName } from "./model.ts";

type ResolveFarm = Pick<BrowserFarm, "targetForProfile">;

export interface ResolvedProviderTarget {
  readonly session: string;
  readonly profile: string;
  readonly target: BrowserListEntry;
}

export function providerSessionProfileName(session: string): string {
  return providerProfileName(session);
}

export async function resolveProviderTarget(
  session: string,
  farm: ResolveFarm,
  signal?: AbortSignal,
): Promise<ResolvedProviderTarget> {
  const profile = providerSessionProfileName(session);
  const target = await farm.targetForProfile(profile, signal);
  if (target === undefined) {
    throw new CliError(
      "browser_target_not_found",
      `browser profile ${profile} has no live Browser target`,
      `launch agent-browser session ${session} before resolving its Browser target`,
    );
  }
  if (target.state !== "running") {
    throw new CliError(
      "browser_target_not_running",
      `Browser target ${target.name} is ${target.state}`,
      `restart agent-browser session ${session} before resolving its Browser target`,
    );
  }
  if (target.slotConflict) {
    throw new CliError(
      "browser_target_slot_conflict",
      `Browser target ${target.name} shares slot ${target.slot} with another target`,
      "destroy the stale target before resolving the agent-browser session",
    );
  }
  return { session, profile, target };
}
