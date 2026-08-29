import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentbrowseConfig } from "../config/deployment.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function configPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-config-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "config.json");
}

test("deployment defaults retain shared policy but require installed backends", () => {
  const path = configPath();
  const config = loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path });

  expect(config).toMatchObject({
    version: 2,
    path,
    backends: [],
    images: { defaultImage: null },
    browser: { nekoLogLevel: "info", timezone: null },
    provider: {
      name: "agentbrowse",
      description: "Manage ordered Kernel browser backends",
    },
    liveView: {
      labelPrefix: "agentbrowse",
      username: "kernel",
      password: "admin",
      readOnly: false,
    },
    discovery: { commandTimeoutMs: 2_000 },
  });
});

test("version 2 preserves backend order and applies safe Apple defaults", () => {
  const path = configPath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      backends: [
        {
          id: "remote-docker",
          type: "docker",
          context: "remote-browser",
          expectedEndpoint: "ssh://browser-host",
          expectedEngine: "browser-host",
          remoteHost: "browser-host",
          networkAddress: "192.0.2.10",
        },
        { id: "apple-container-local", type: "apple-container" },
      ],
      images: { defaultImage: "browser@test" },
      browser: { nekoLogLevel: "debug", timezone: "UTC" },
      provider: { name: "browser-provider", description: "Ordered browsers" },
      liveView: { labelPrefix: "browser", username: "viewer", password: "secret" },
      discovery: { commandTimeoutMs: 1_500 },
    }),
  );

  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: path,
    AGENTBROWSE_IMAGE: "override@test",
    AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS: "1200",
  });

  expect(config.backends.map((backend) => [backend.id, backend.type])).toEqual([
    ["remote-docker", "docker"],
    ["apple-container-local", "apple-container"],
  ]);
  expect(config.backends[1]).toMatchObject({
    command: "/usr/local/bin/container",
    maxTargets: 1,
    cpus: 2,
    memory: "6G",
  });
  expect(config.images.defaultImage).toBe("override@test");
  expect(config.discovery.commandTimeoutMs).toBe(1_200);
});

test("invalid versions, duplicate ids, and unsafe Apple capacity fail locally", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ docker: { context: "legacy" } }));
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow(
    "must declare version 2",
  );

  writeFileSync(path, JSON.stringify({ version: 1 }));
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow(
    "unsupported version 1",
  );

  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      backends: [
        {
          id: "same",
          type: "docker",
          context: "one",
          remoteHost: "one",
          networkAddress: "192.0.2.1",
        },
        { id: "same", type: "apple-container" },
      ],
    }),
  );
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow("duplicate backend id");

  writeFileSync(
    path,
    JSON.stringify({
      version: 2,
      backends: [{ id: "local", type: "apple-container", maxTargets: 2 }],
    }),
  );
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow("maxTargets must be 1");
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: "relative.json" })).toThrow(
    "must be an absolute path",
  );
});
