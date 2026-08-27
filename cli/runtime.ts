import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentbrowseConfig } from "../config/deployment.ts";
import { DockerFarmBackend } from "./backend.ts";
import { BrowserFarm } from "./farm.ts";

export function runtimeDir(env: Readonly<Record<string, string | undefined>>): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return env.AGENTBROWSE_RUNTIME_DIR ?? join(tmpdir(), `agentbrowse-live-view-${uid}`);
}

export function browserFarm(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowserFarm {
  const config = loadAgentbrowseConfig(env);
  return new BrowserFarm(
    new DockerFarmBackend(config),
    runtimeDir(env),
    config.browser.nekoLogLevel,
  );
}
