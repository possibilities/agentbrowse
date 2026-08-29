import type { BrowserListEntry } from "../cli/farm.ts";
import { browserFarm } from "../cli/runtime.ts";

export interface BrowserTargetChoice extends BrowserListEntry {
  selectable: boolean;
  disabledReason: string | null;
}

export interface BrowserTargetSource {
  list(signal?: AbortSignal): Promise<readonly BrowserListEntry[]>;
}

/** Discover Browser targets through the typed fleet API, never CLI JSON. */
export async function listBrowserTargets(
  source: BrowserTargetSource = browserFarm(),
  signal?: AbortSignal,
): Promise<readonly BrowserTargetChoice[]> {
  return (await source.list(signal)).map((target) => {
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
