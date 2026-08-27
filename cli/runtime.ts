import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerFarmBackend } from "./backend.ts";
import { BrowserFarm } from "./farm.ts";

export function runtimeDir(env: Readonly<Record<string, string | undefined>>): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return env.AGENTBROWSE_RUNTIME_DIR ?? join(tmpdir(), `agentbrowse-live-view-${uid}`);
}

export function browserFarm(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowserFarm {
  return new BrowserFarm(
    new DockerFarmBackend(env),
    runtimeDir(env),
    env.AGENTBROWSE_NEKO_LOG_LEVEL ?? "info",
  );
}
