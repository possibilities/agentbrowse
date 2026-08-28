import { fileURLToPath } from "node:url";

import type { BrowserFarm } from "./farm.ts";
import { providerSessionProfileName, resolveProviderTarget } from "./resolve.ts";
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
  return providerSessionProfileName(session);
}

export async function runView(
  session: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launcher: ViewLauncher = launchLiveView,
  farm: ViewFarm = browserFarm(env),
): Promise<number> {
  const { target } = await resolveProviderTarget(session, farm);
  return await launcher(target.name, env);
}
