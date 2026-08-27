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

test("deployment defaults are generic and leave host choices unconfigured", () => {
  const path = configPath();
  const config = loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path });

  expect(config).toMatchObject({
    path,
    docker: { context: null, expectedEndpoint: null, expectedEngine: null },
    remote: { host: null, networkAddress: null, networkAddressCommand: null },
    images: { defaultImage: null, sourceDirectory: null },
    browser: { nekoLogLevel: "info", timezone: null },
    provider: {
      name: "agentbrowse",
      description: "Manage remote Kernel browser targets",
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

test("versioned deployment config is shared and environment values override it", () => {
  const path = configPath();
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      docker: {
        context: "remote-browser",
        expectedEndpoint: "ssh://remote-browser",
        expectedEngine: "browser-engine",
      },
      remote: {
        host: "remote-browser",
        networkAddressCommand: "network-tool address --ipv4",
      },
      images: { defaultImage: "browser:test", sourceDirectory: "/srv/kernel-images" },
      browser: { nekoLogLevel: "debug", timezone: "UTC" },
      provider: { name: "remote-browser", description: "Remote browsers" },
      liveView: {
        labelPrefix: "remote",
        username: "viewer",
        password: "secret",
        readOnly: true,
      },
      discovery: { commandTimeoutMs: 1_500 },
    }),
  );

  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: path,
    AGENTBROWSE_REMOTE_HOST: "override-host",
    AGENTBROWSE_NETWORK_ADDRESS: "198.51.100.10",
    AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS: "1200",
  });

  expect(config).toMatchObject({
    docker: {
      context: "remote-browser",
      expectedEndpoint: "ssh://remote-browser",
      expectedEngine: "browser-engine",
    },
    remote: {
      host: "override-host",
      networkAddress: "198.51.100.10",
      networkAddressCommand: null,
    },
    images: { defaultImage: "browser:test", sourceDirectory: "/srv/kernel-images" },
    browser: { nekoLogLevel: "debug", timezone: "UTC" },
    provider: { name: "remote-browser", description: "Remote browsers" },
    liveView: {
      labelPrefix: "remote",
      username: "viewer",
      password: "secret",
      readOnly: true,
    },
    discovery: { commandTimeoutMs: 1_200 },
  });
});

test("invalid deployment config fails before any remote command", () => {
  const path = configPath();
  writeFileSync(path, JSON.stringify({ version: 2 }));

  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow(
    "unsupported version 2",
  );
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: "relative.json" })).toThrow(
    "must be an absolute path",
  );

  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      remote: {
        networkAddress: "192.0.2.10",
        networkAddressCommand: "network-tool address --ipv4",
      },
    }),
  );
  expect(() => loadAgentbrowseConfig({ AGENTBROWSE_CONFIG: path })).toThrow(
    "are mutually exclusive",
  );
});
