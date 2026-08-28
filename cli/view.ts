import { fileURLToPath } from "node:url";

import { CliError } from "./errors.ts";
import type { BrowserFarm } from "./farm.ts";
import { providerProfileName } from "./model.ts";
import { browserFarm } from "./runtime.ts";

const LIVE_VIEW = fileURLToPath(new URL("../tools/live-view", import.meta.url));

export type ViewLauncher = (
  target: string,
  env: Readonly<Record<string, string | undefined>>,
) => Promise<number>;

async function launchLiveView(
  target: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const child = Bun.spawn([LIVE_VIEW, "launch", target], {
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  return await child.exited;
}

type ViewFarm = Pick<BrowserFarm, "targetForProfile">;

export function viewProfileName(session: string): string {
  return providerProfileName(session);
}

export async function runView(
  session: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launcher: ViewLauncher = launchLiveView,
  farm: ViewFarm = browserFarm(env),
): Promise<number> {
  const profile = viewProfileName(session);
  const target = await farm.targetForProfile(profile);
  if (target === undefined) {
    throw new CliError(
      "browser_target_not_found",
      `browser profile ${profile} has no live Browser target`,
      `launch agent-browser session ${session} before opening Live View`,
    );
  }
  if (target.state !== "running") {
    throw new CliError(
      "browser_target_not_running",
      `Browser target ${target.name} is ${target.state}`,
      `restart agent-browser session ${session} before opening Live View`,
    );
  }
  if (target.slotConflict) {
    throw new CliError(
      "browser_target_slot_conflict",
      `Browser target ${target.name} shares slot ${target.slot} with another target`,
      "destroy the stale target before opening Live View",
    );
  }
  return await launcher(target.name, env);
}
