import type { BrowserListEntry } from "../cli/farm.ts";
import { browserFarm } from "../cli/runtime.ts";

export interface BrowserTargetChoice extends BrowserListEntry {
  selectable: boolean;
  disabledReason: string | null;
}

export interface BrowserTargetSource {
  list(): Promise<readonly BrowserListEntry[]>;
}

/** Discover Browser targets through the typed farm API, never CLI JSON. */
export async function listBrowserTargets(
  source: BrowserTargetSource = browserFarm(),
): Promise<readonly BrowserTargetChoice[]> {
  return (await source.list()).map((target) => {
    const disabledReason = target.slotConflict
      ? `slot ${target.slot} conflict`
      : target.state !== "running"
        ? target.status || target.state
        : null;
    return {
      ...target,
      selectable: disabledReason === null,
      disabledReason,
    };
  });
}
