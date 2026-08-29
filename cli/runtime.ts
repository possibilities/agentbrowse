import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentbrowseConfig } from "../config/deployment.ts";
import { AppleContainerFarmBackend } from "./apple-backend.ts";
import { DockerFarmBackend } from "./backend.ts";
import { BrowserFarm } from "./farm.ts";
import { BrowserFleet } from "./fleet.ts";

export function runtimeDir(env: Readonly<Record<string, string | undefined>>): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return env.AGENTBROWSE_RUNTIME_DIR ?? join(tmpdir(), `agentbrowse-live-view-${uid}`);
}

export function browserFarm(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BrowserFleet {
  const config = loadAgentbrowseConfig(env);
  const directory = runtimeDir(env);
  return new BrowserFleet(
    config.backends.map(
      (backend) =>
        new BrowserFarm(
          backend.type === "docker"
            ? new DockerFarmBackend(backend, config)
            : new AppleContainerFarmBackend(backend, config),
          directory,
          config.browser.nekoLogLevel,
        ),
    ),
  );
}
