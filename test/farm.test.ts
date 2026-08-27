import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ContainerState, FarmBackend, RunBrowserInput } from "../cli/backend.ts";
import { CliError } from "../cli/errors.ts";
import { BrowserFarm } from "../cli/farm.ts";
import { configPath, targetFor } from "../cli/model.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtimeDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function managedState(name: string, slot: number, image: string, ip: string): ContainerState {
  const target = targetFor(name, slot);
  return {
    image,
    labels: {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "kernel-browser",
      "dev.agentbrowse.target": name,
      "dev.agentbrowse.slot": String(slot),
    },
    environment: [
      "ENABLE_WEBRTC=true",
      `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
      `NEKO_WEBRTC_NAT1TO1=${ip}`,
    ],
    running: true,
    bindings: {
      "8080/tcp": [{ hostIp: "127.0.0.1", hostPort: String(target.httpPort) }],
      [`${target.webrtcPort}/udp`]: [{ hostIp: ip, hostPort: String(target.webrtcPort) }],
      "9222/tcp": [{ hostIp: ip, hostPort: String(target.cdpPort) }],
    },
  };
}

class FakeBackend implements FarmBackend {
  readonly ip = "100.64.0.8";
  readonly image = "agentbrowse/kernel-headful:test";
  existing: ContainerState | undefined;
  imagePresent = true;
  verified = 0;
  started: string[] = [];
  waited: string[] = [];
  removed: string[] = [];
  runs: RunBrowserInput[] = [];

  async verifyHost(): Promise<void> {
    this.verified += 1;
  }

  async resolveTailnetIp(): Promise<string> {
    return this.ip;
  }

  async resolveImage(override?: string): Promise<string> {
    return override ?? this.image;
  }

  async imageExists(): Promise<boolean> {
    return this.imagePresent;
  }

  async inspectContainer(): Promise<ContainerState | undefined> {
    return this.existing;
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    this.runs.push(input);
    this.existing = managedState(
      input.target.name,
      input.target.slot,
      input.image,
      input.tailnetIp,
    );
  }

  async startContainer(container: string): Promise<void> {
    this.started.push(container);
  }

  async waitReady(container: string): Promise<void> {
    this.waited.push(container);
  }

  async removeContainer(container: string): Promise<void> {
    this.removed.push(container);
    this.existing = undefined;
  }
}

test("create launches a combined CDP and Live View target and records it", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);
  const result = await farm.create({ name: "testing", slot: 3 });

  expect(result).toMatchObject({
    name: "testing",
    slot: 3,
    container: "agentbrowse-browser-testing",
    image: backend.image,
    cdpUrl: "http://100.64.0.8:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    created: true,
  });
  expect(backend.runs).toHaveLength(1);
  expect(backend.runs[0]).toMatchObject({
    target: { cdpPort: 9225, httpPort: 18083, webrtcPort: 56003 },
    nekoLogLevel: "info",
  });
  expect(readFileSync(configPath(directory, "testing"), "utf8")).toContain("CDP_PORT=9225");
  expect(backend.waited).toEqual(["agentbrowse-browser-testing"]);
});

test("create reuses an exactly matching managed container", async () => {
  const backend = new FakeBackend();
  backend.existing = managedState("testing", 2, backend.image, backend.ip);
  backend.existing = { ...backend.existing, running: false };
  const farm = new BrowserFarm(backend, runtimeDir());

  const result = await farm.create({ name: "testing", slot: 2 });

  expect(result.created).toBe(false);
  expect(backend.runs).toHaveLength(0);
  expect(backend.started).toEqual(["agentbrowse-browser-testing"]);
});

test("create fails closed when an existing container drifts", async () => {
  const backend = new FakeBackend();
  backend.existing = {
    ...managedState("testing", 2, backend.image, backend.ip),
    labels: { "dev.agentbrowse.managed": "false" },
  };
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.create({ name: "testing", slot: 2 })).rejects.toMatchObject({
    code: "browser_drift",
  });
  expect(backend.runs).toHaveLength(0);
});

test("destroy verifies ownership before removing the exact container", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);
  await farm.create({ name: "testing", slot: 5 });

  const result = await farm.destroy("testing");

  expect(result).toEqual({
    name: "testing",
    container: "agentbrowse-browser-testing",
    destroyed: true,
  });
  expect(backend.removed).toEqual(["agentbrowse-browser-testing"]);
  expect(() => readFileSync(configPath(directory, "testing"), "utf8")).toThrow();
});

test("destroy refuses a foreign container", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);
  await farm.create({ name: "testing", slot: 5 });
  backend.existing = {
    ...backend.existing!,
    labels: { "dev.agentbrowse.target": "someone-else" },
  };

  await expect(farm.destroy("testing")).rejects.toBeInstanceOf(CliError);
  expect(backend.removed).toHaveLength(0);
});

test("destroy is idempotent when both metadata and container are absent", async () => {
  const backend = new FakeBackend();
  const farm = new BrowserFarm(backend, runtimeDir());

  expect(await farm.destroy("missing")).toEqual({
    name: "missing",
    container: "agentbrowse-browser-missing",
    destroyed: false,
  });
  expect(backend.removed).toHaveLength(0);
});

test("destroy recovers ownership from labels when local metadata is absent", async () => {
  const backend = new FakeBackend();
  backend.existing = managedState("testing", 8, backend.image, backend.ip);
  const farm = new BrowserFarm(backend, runtimeDir());

  expect(await farm.destroy("testing")).toEqual({
    name: "testing",
    container: "agentbrowse-browser-testing",
    destroyed: true,
  });
  expect(backend.removed).toEqual(["agentbrowse-browser-testing"]);
});
