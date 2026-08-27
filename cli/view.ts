import { fileURLToPath } from "node:url";

import { providerTargetName } from "./model.ts";

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

export function viewTargetName(session: string): string {
  return providerTargetName(session);
}

export async function runView(
  session: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  launcher: ViewLauncher = launchLiveView,
): Promise<number> {
  return await launcher(viewTargetName(session), env);
}
