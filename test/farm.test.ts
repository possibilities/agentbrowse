import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ContainerState,
  FarmBackend,
  ManagedContainerRecord,
  ManagedProfileRecord,
  ProfileConsumerRecord,
  ProfileState,
  RunBrowserInput,
} from "../cli/backend.ts";
import { drift, verifyCommonOwnership } from "../cli/backend.ts";
import { CliError } from "../cli/errors.ts";
import { BrowserFarm } from "../cli/farm.ts";
import {
  type BrowserProfile,
  CHROMIUM_FLAGS,
  configPath,
  PROFILE_MOUNT_PATH,
  PROFILE_SCHEMA_VERSION,
  targetFor,
} from "../cli/model.ts";

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

function managedState(
  name: string,
  slot: number,
  image: string,
  ip: string,
  profile = name,
): ContainerState {
  const target = targetFor(name, slot, { profile });
  return {
    image,
    labels: {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "kernel-browser",
      "dev.agentbrowse.backend": "docker",
      "dev.agentbrowse.target": name,
      "dev.agentbrowse.profile": profile,
      "dev.agentbrowse.slot": String(slot),
    },
    environment: [
      "ENABLE_WEBRTC=true",
      `CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`,
      `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
      `NEKO_WEBRTC_NAT1TO1=${ip}`,
    ],
    command: [],
    running: true,
    addresses: [],
    bindings: {
      "8080/tcp": [{ hostIp: "127.0.0.1", hostPort: String(target.httpPort) }],
      [`${target.webrtcPort}/udp`]: [{ hostIp: ip, hostPort: String(target.webrtcPort) }],
      "9222/tcp": [{ hostIp: ip, hostPort: String(target.cdpPort) }],
    },
    mounts: [
      {
        type: "volume",
        name: `agentbrowse-profile-${profile}`,
        destination: PROFILE_MOUNT_PATH,
        writable: true,
      },
    ],
  };
}

function profileState(profile: BrowserProfile): ProfileState {
  return {
    volume: profile.volume,
    driver: "local",
    labels: {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "browser-profile",
      "dev.agentbrowse.backend": "docker",
      "dev.agentbrowse.profile": profile.name,
      "dev.agentbrowse.profile.schema": String(PROFILE_SCHEMA_VERSION),
    },
  };
}

class FakeBackend implements FarmBackend {
  readonly id = "docker";
  readonly type = "docker" as const;
  readonly maxTargets = 1_000;
  readonly ip = "192.0.2.10";
  readonly image = "agentbrowse/kernel-headful:test";
  existing: ContainerState | undefined;
  existingContainer: string | undefined;
  imagePresent = true;
  managed: ManagedContainerRecord[] = [];
  profiles = new Map<string, ProfileState>();
  profileConsumers = new Map<string, ProfileConsumerRecord[]>();
  verified = 0;
  started: string[] = [];
  waited: string[] = [];
  waitTimeouts: number[] = [];
  removed: string[] = [];
  removedProfiles: string[] = [];
  runs: RunBrowserInput[] = [];

  newContainerName(name: string): string {
    return `agentbrowse-browser-${name}`;
  }

  async verifyHost(): Promise<void> {
    this.verified += 1;
  }

  async resolveNetworkAddress(): Promise<string> {
    return this.ip;
  }

  async resolveImage(override?: string): Promise<string> {
    return override ?? this.image;
  }

  async imageExists(): Promise<boolean> {
    return this.imagePresent;
  }

  async listManagedProfiles(): Promise<readonly ManagedProfileRecord[]> {
    return [...this.profiles.entries()].map(([name, state]) => ({
      name,
      volume: state.volume,
    }));
  }

  async inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined> {
    return this.profiles.get(profile.name);
  }

  async createProfile(profile: BrowserProfile): Promise<void> {
    this.profiles.set(profile.name, profileState(profile));
  }

  async listProfileConsumers(profile: BrowserProfile): Promise<readonly ProfileConsumerRecord[]> {
    return this.profileConsumers.get(profile.name) ?? [];
  }

  async removeProfile(profile: BrowserProfile): Promise<void> {
    this.removedProfiles.push(profile.name);
    this.profiles.delete(profile.name);
  }

  async listManagedContainers(): Promise<readonly ManagedContainerRecord[]> {
    return this.managed;
  }

  async inspectContainer(container: string): Promise<ContainerState | undefined> {
    if (this.existingContainer !== undefined && container !== this.existingContainer) {
      return undefined;
    }
    return this.existing;
  }

  async verifyContainer(
    state: ContainerState,
    target: ReturnType<typeof targetFor>,
    image: string,
  ) {
    verifyCommonOwnership(state, target, image);
    if (!state.environment.includes(`CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`)) {
      drift(`${target.container} uses different Chromium window flags`);
    }
  }

  async browserAccess(target: ReturnType<typeof targetFor>) {
    return {
      cdpUrl: `http://${this.ip}:${target.cdpPort}`,
      liveViewUrl: `http://127.0.0.1:${target.httpPort}`,
      liveViewAccess: {
        mode: "ssh" as const,
        remoteHost: "browser-host",
        remotePort: target.httpPort,
      },
    };
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    this.runs.push(input);
    this.existingContainer = input.target.container;
    this.existing = managedState(
      input.target.name,
      input.target.slot,
      input.image,
      this.ip,
      input.target.profile,
    );
  }

  async startContainer(container: string): Promise<void> {
    this.started.push(container);
  }

  async waitReady(target: ReturnType<typeof targetFor>, timeoutSeconds = 120): Promise<void> {
    this.waited.push(target.container);
    this.waitTimeouts.push(timeoutSeconds);
  }

  async removeContainer(container: string): Promise<void> {
    this.removed.push(container);
    if (this.existingContainer === undefined || this.existingContainer === container) {
      this.existing = undefined;
      this.existingContainer = undefined;
    }
  }

  missingImageRecovery(): string {
    return "load it";
  }
}

test("create launches a combined CDP and Live View target and records it", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);
  const result = await farm.create({ name: "testing", slot: 3 });

  expect(result).toMatchObject({
    name: "testing",
    profile: "testing",
    backend: "docker",
    slot: 3,
    container: "agentbrowse-browser-testing",
    image: backend.image,
    cdpUrl: "http://192.0.2.10:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    created: true,
  });
  expect(backend.runs).toHaveLength(1);
  expect(backend.runs[0]).toMatchObject({
    target: { profile: "testing", cdpPort: 9225, httpPort: 18083, webrtcPort: 56003 },
    nekoLogLevel: "info",
  });
  expect(JSON.parse(readFileSync(configPath(directory, "testing"), "utf8"))).toMatchObject({
    version: 2,
    backend: "docker",
    container: "agentbrowse-browser-testing",
    target: "testing",
    profile: "testing",
    slot: 3,
  });
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

test("provider provisioning reuses the target currently bound to its profile", async () => {
  const backend = new FakeBackend();
  backend.managed = [
    {
      name: "testing-deadbeef",
      profile: "testing",
      slot: 7,
      container: "agentbrowse-browser-testing-deadbeef",
      state: "running",
      status: "Up 1 minute",
    },
  ];
  backend.existing = managedState("testing-deadbeef", 7, backend.image, backend.ip, "testing");
  const farm = new BrowserFarm(backend, runtimeDir());

  const result = await farm.provisionProfile({ profile: "testing" });

  expect(result).toMatchObject({
    name: "testing-deadbeef",
    profile: "testing",
    slot: 7,
    created: false,
  });
  expect(backend.runs).toHaveLength(0);
  expect(backend.waitTimeouts).toEqual([45]);
});

test("provider provisioning allocates the first unoccupied slot", async () => {
  const backend = new FakeBackend();
  backend.managed = [
    {
      name: "first",
      profile: "first",
      slot: 0,
      container: "agentbrowse-browser-first",
      state: "running",
      status: "Up 1 minute",
    },
    {
      name: "third",
      profile: "third",
      slot: 2,
      container: "agentbrowse-browser-third",
      state: "running",
      status: "Up 1 minute",
    },
  ];
  const farm = new BrowserFarm(backend, runtimeDir(), "info", () => "deadbeefcafebabe");

  const result = await farm.provisionProfile({ profile: "testing" });

  expect(result).toMatchObject({
    name: "testing-deadbeefcafebabe",
    profile: "testing",
    slot: 1,
    created: true,
  });
  expect(backend.runs[0]?.target.slot).toBe(1);
  expect(backend.waitTimeouts).toEqual([45]);
});

test("provider provisioning refuses when every slot is occupied", async () => {
  const backend = new FakeBackend();
  backend.managed = Array.from({ length: 1000 }, (_, slot) => ({
    name: `target-${slot}`,
    profile: `target-${slot}`,
    slot,
    container: `agentbrowse-browser-target-${slot}`,
    state: "running",
    status: "Up 1 minute",
  }));
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.provisionProfile({ profile: "testing" })).rejects.toMatchObject({
    code: "no_free_slots",
  });
  expect(backend.runs).toHaveLength(0);
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

test("create rejects a browser with different window flags", async () => {
  const backend = new FakeBackend();
  const state = managedState("testing", 2, backend.image, backend.ip);
  backend.existing = {
    ...state,
    environment: state.environment.filter((value) => value !== `CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`),
  };
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.create({ name: "testing", slot: 2 })).rejects.toMatchObject({
    code: "browser_drift",
    message: "agentbrowse-browser-testing uses different Chromium window flags",
  });
  expect(backend.runs).toHaveLength(0);
});

test("create rejects a target without the exact writable Browser profile mount", async () => {
  const backend = new FakeBackend();
  const state = managedState("testing", 2, backend.image, backend.ip);
  backend.existing = {
    ...state,
    mounts: state.mounts.map((mount) => ({ ...mount, writable: false })),
  };
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.create({ name: "testing", slot: 2 })).rejects.toMatchObject({
    code: "browser_drift",
    message: expect.stringContaining("writable browser profile mount"),
  });
  expect(backend.runs).toHaveLength(0);
});

test("create rejects a slot occupied by another managed browser", async () => {
  const backend = new FakeBackend();
  backend.managed = [
    {
      name: "existing",
      profile: "existing",
      slot: 2,
      container: "agentbrowse-browser-existing",
      state: "running",
      status: "Up 1 minute",
    },
  ];
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.create({ name: "testing", slot: 2 })).rejects.toMatchObject({
    code: "slot_in_use",
    message: "slot 2 is already used by Browser target existing (running)",
  });
  expect(backend.runs).toHaveLength(0);
});

test("list sorts browsers and marks duplicate slots", async () => {
  const backend = new FakeBackend();
  backend.managed = [
    {
      name: "second",
      profile: "second",
      slot: 4,
      container: "agentbrowse-browser-second",
      state: "running",
      status: "Up 2 minutes",
    },
    {
      name: "first",
      profile: "first",
      slot: 3,
      container: "agentbrowse-browser-first",
      state: "created",
      status: "Created",
    },
    {
      name: "collision",
      profile: "collision",
      slot: 4,
      container: "agentbrowse-browser-collision",
      state: "created",
      status: "Created",
    },
  ];
  const farm = new BrowserFarm(backend, runtimeDir());

  const result = await farm.list();

  expect(result.map((browser) => browser.name)).toEqual(["first", "collision", "second"]);
  expect(result[0]).toMatchObject({
    cdpUrl: "http://192.0.2.10:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    slotConflict: false,
  });
  expect(result[1]?.slotConflict).toBe(true);
  expect(result[2]?.slotConflict).toBe(true);
});

test("manual create can bind a target name to a separate durable Browser profile", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);

  const result = await farm.create({ name: "one-run", profile: "signed-in", slot: 6 });

  expect(result).toMatchObject({ name: "one-run", profile: "signed-in", created: true });
  expect(backend.runs[0]?.target.profile).toBe("signed-in");
  expect(JSON.parse(readFileSync(configPath(directory, "one-run"), "utf8"))).toMatchObject({
    profile: "signed-in",
    backend: "docker",
  });
});

test("a stopped target prevents another target from mounting the same Browser profile", async () => {
  const backend = new FakeBackend();
  backend.managed = [
    {
      name: "old-incarnation",
      profile: "testing",
      slot: 4,
      container: "agentbrowse-browser-old-incarnation",
      state: "exited",
      status: "Exited (0)",
    },
  ];
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(
    farm.create({ name: "new-incarnation", profile: "testing", slot: 5 }),
  ).rejects.toMatchObject({
    code: "profile_in_use",
    message: expect.stringContaining("old-incarnation (exited)"),
  });
  expect(backend.runs).toHaveLength(0);
});

test("a foreign volume consumer prevents Browser profile reuse", async () => {
  const backend = new FakeBackend();
  backend.profileConsumers.set("testing", [
    { container: "foreign-debug-container", state: "exited" },
  ]);
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(
    farm.create({ name: "testing-deadbeef", profile: "testing", slot: 5 }),
  ).rejects.toMatchObject({
    code: "profile_in_use",
    message: expect.stringContaining("foreign-debug-container (exited)"),
  });
  expect(backend.runs).toHaveLength(0);
});

test("profile lifecycle is explicit and deletion refuses every mounted consumer", async () => {
  const backend = new FakeBackend();
  const farm = new BrowserFarm(backend, runtimeDir());

  expect(await farm.createProfile("testing")).toEqual({
    name: "testing",
    volume: "agentbrowse-profile-testing",
    backend: "docker",
    created: true,
  });
  expect((await farm.createProfile("testing")).created).toBe(false);

  backend.profileConsumers.set("testing", [
    { container: "agentbrowse-browser-testing-deadbeef", state: "running" },
  ]);
  expect(await farm.listProfiles()).toEqual([
    {
      name: "testing",
      volume: "agentbrowse-profile-testing",
      backend: "docker",
      consumers: ["agentbrowse-browser-testing-deadbeef"],
    },
  ]);

  await expect(farm.deleteProfile("testing")).rejects.toMatchObject({
    code: "profile_in_use",
  });
  backend.profileConsumers.set("testing", []);
  expect(await farm.deleteProfile("testing")).toEqual({
    name: "testing",
    volume: "agentbrowse-profile-testing",
    backend: "docker",
    deleted: true,
  });
  expect(backend.removedProfiles).toEqual(["testing"]);
  expect((await farm.deleteProfile("testing")).deleted).toBe(false);
});

test("profile lifecycle refuses a same-named volume with drifted ownership", async () => {
  const backend = new FakeBackend();
  const profile = { name: "testing", volume: "agentbrowse-profile-testing" };
  backend.profiles.set("testing", {
    ...profileState(profile),
    labels: { "dev.agentbrowse.managed": "false" },
  });
  const farm = new BrowserFarm(backend, runtimeDir());

  await expect(farm.createProfile("testing")).rejects.toMatchObject({ code: "profile_drift" });
  await expect(farm.deleteProfile("testing")).rejects.toMatchObject({ code: "profile_drift" });
  expect(backend.removedProfiles).toHaveLength(0);
});

test("relaunch gives one durable profile a fresh exact target identity", async () => {
  const backend = new FakeBackend();
  const tokens = ["1111111111111111", "2222222222222222"];
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory, "info", () => tokens.shift()!);

  const first = await farm.provisionProfile({ profile: "testing" });
  expect(first).toMatchObject({ name: "testing-1111111111111111", profile: "testing" });
  await farm.destroy(first.name);
  expect(backend.profiles.has("testing")).toBe(true);
  expect(() => readFileSync(configPath(directory, first.name), "utf8")).toThrow();

  const second = await farm.provisionProfile({ profile: "testing" });
  expect(second).toMatchObject({ name: "testing-2222222222222222", profile: "testing" });
  expect(second.name).not.toBe(first.name);
  expect(backend.removed).toEqual(["agentbrowse-browser-testing-1111111111111111"]);

  expect(await farm.destroy(first.name)).toEqual({
    name: "testing-1111111111111111",
    profile: null,
    backend: "docker",
    container: "agentbrowse-browser-testing-1111111111111111",
    destroyed: false,
  });
  expect(backend.removed).toEqual(["agentbrowse-browser-testing-1111111111111111"]);
  expect(backend.existingContainer).toBe("agentbrowse-browser-testing-2222222222222222");
});

test("destroy verifies ownership before removing the exact container", async () => {
  const backend = new FakeBackend();
  const directory = runtimeDir();
  const farm = new BrowserFarm(backend, directory);
  await farm.create({ name: "testing", slot: 5 });

  const result = await farm.destroy("testing");

  expect(result).toEqual({
    name: "testing",
    profile: "testing",
    backend: "docker",
    container: "agentbrowse-browser-testing",
    destroyed: true,
  });
  expect(backend.removed).toEqual(["agentbrowse-browser-testing"]);
  expect(backend.profiles.has("testing")).toBe(true);
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
    profile: null,
    backend: "docker",
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
    profile: "testing",
    backend: "docker",
    container: "agentbrowse-browser-testing",
    destroyed: true,
  });
  expect(backend.removed).toEqual(["agentbrowse-browser-testing"]);
});
