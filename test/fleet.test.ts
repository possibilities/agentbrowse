import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
import { CliError } from "../cli/errors.ts";
import { BrowserFarm } from "../cli/farm.ts";
import { BrowserFleet } from "../cli/fleet.ts";
import type { BrowserAccess, BrowserProfile } from "../cli/model.ts";
import { PROFILE_MOUNT_PATH, PROFILE_SCHEMA_VERSION } from "../cli/model.ts";
import { ProfileBindingStore } from "../cli/profile-binding.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runtimeDir(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-fleet-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

class FleetBackend implements FarmBackend {
  readonly type = "docker" as const;
  readonly events: string[] = [];
  readonly probeSignals: Array<AbortSignal | undefined> = [];
  probeError: CliError | null = null;
  verifyError: CliError | null = null;
  runError: CliError | null = null;
  imagePresent = true;
  state: ContainerState | undefined;
  profiles = new Map<string, ProfileState>();

  constructor(
    readonly id: string,
    readonly maxTargets = 1_000,
  ) {}

  newContainerName(name: string): string {
    return `agentbrowse-browser-${name}-${this.id}`;
  }

  async verifyHost(signal?: AbortSignal): Promise<void> {
    this.events.push("probe");
    this.probeSignals.push(signal);
    if (this.probeError !== null) throw this.probeError;
  }

  async resolveImage(override?: string): Promise<string> {
    return override ?? "browser@test";
  }

  async imageExists(): Promise<boolean> {
    this.events.push("image");
    return this.imagePresent;
  }

  async listManagedProfiles(): Promise<readonly ManagedProfileRecord[]> {
    return [...this.profiles.entries()].map(([name, state]) => ({ name, volume: state.volume }));
  }

  async inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined> {
    return this.profiles.get(profile.name);
  }

  async createProfile(profile: BrowserProfile): Promise<void> {
    this.profiles.set(profile.name, {
      volume: profile.volume,
      driver: "test",
      labels: {
        "dev.agentbrowse.managed": "true",
        "dev.agentbrowse.role": "browser-profile",
        "dev.agentbrowse.backend": this.id,
        "dev.agentbrowse.profile": profile.name,
        "dev.agentbrowse.profile.schema": String(PROFILE_SCHEMA_VERSION),
      },
    });
  }

  async listProfileConsumers(profile: BrowserProfile): Promise<readonly ProfileConsumerRecord[]> {
    if (
      this.state?.mounts.some((mount) => mount.type === "volume" && mount.name === profile.volume)
    ) {
      return [
        {
          container: this.state.labels["test.container"]!,
          state: this.state.running ? "running" : "stopped",
        },
      ];
    }
    return [];
  }

  async removeProfile(profile: BrowserProfile): Promise<void> {
    this.profiles.delete(profile.name);
  }

  async listManagedContainers(): Promise<readonly ManagedContainerRecord[]> {
    this.events.push("list");
    if (this.state === undefined) return [];
    return [
      {
        name: this.state.labels["dev.agentbrowse.target"]!,
        profile: this.state.labels["dev.agentbrowse.profile"]!,
        slot: Number(this.state.labels["dev.agentbrowse.slot"]),
        container: this.state.labels["test.container"]!,
        state: this.state.running ? "running" : "stopped",
        status: this.state.running ? "Running" : "Stopped",
      },
    ];
  }

  async inspectContainer(container: string): Promise<ContainerState | undefined> {
    this.events.push("inspect");
    return this.state?.labels["test.container"] === container ? this.state : undefined;
  }

  async verifyContainer(): Promise<void> {
    this.events.push("verify-container");
    if (this.verifyError !== null) throw this.verifyError;
  }

  async browserAccess(): Promise<BrowserAccess> {
    return {
      cdpUrl: `http://${this.id}:9222`,
      liveViewUrl: `http://${this.id}:8080`,
      liveViewAccess: { mode: "direct", baseUrl: `http://${this.id}:8080` },
    };
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    this.events.push("run");
    this.state = {
      image: input.image,
      labels: {
        "dev.agentbrowse.managed": "true",
        "dev.agentbrowse.role": "kernel-browser",
        "dev.agentbrowse.backend": this.id,
        "dev.agentbrowse.target": input.target.name,
        "dev.agentbrowse.profile": input.target.profile,
        "dev.agentbrowse.slot": String(input.target.slot),
        "test.container": input.target.container,
      },
      environment: [],
      command: [],
      running: true,
      addresses: [],
      bindings: {},
      mounts: [
        {
          type: "volume",
          name: `agentbrowse-profile-${input.target.profile}`,
          destination: PROFILE_MOUNT_PATH,
          writable: true,
        },
      ],
    };
    if (this.runError !== null) throw this.runError;
  }

  async startContainer(): Promise<void> {
    this.events.push("start");
  }

  async waitReady(): Promise<void> {
    this.events.push("wait");
  }

  async removeContainer(): Promise<void> {
    this.events.push("remove");
    this.state = undefined;
  }

  missingImageRecovery(): string {
    return `prepare ${this.id}`;
  }
}

function fleet(backends: readonly FleetBackend[], directory = runtimeDir()): BrowserFleet {
  return new BrowserFleet(backends.map((backend) => new BrowserFarm(backend, directory)));
}

test("available first backend wins without touching Apple", async () => {
  const artbird = new FleetBackend("artbird");
  const apple = new FleetBackend("apple-container-local");
  const result = await fleet([artbird, apple]).provisionProfile({ profile: "testing" });

  expect(result.backend).toBe("artbird");
  expect(artbird.events).toContain("run");
  expect(apple.events).toEqual([]);
});

test("classified Artbird unavailability passively selects prepared Apple", async () => {
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  const apple = new FleetBackend("apple-container-local");

  const result = await fleet([artbird, apple]).provisionProfile({ profile: "testing" });

  expect(result.backend).toBe("apple-container-local");
  expect(artbird.events).toEqual(["probe"]);
  expect(artbird.probeSignals[0]).toBeInstanceOf(AbortSignal);
  expect(apple.events).toContain("run");
});

test("two unavailable backends produce one bounded recovery and never start Apple", async () => {
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  const apple = new FleetBackend("apple-container-local");
  apple.probeError = new CliError(
    "apple_service_stopped",
    "local Apple container service is disabled",
    "run agentbrowse-infra enable",
  );

  await expect(
    fleet([artbird, apple]).provisionProfile({ profile: "testing" }),
  ).rejects.toMatchObject({
    code: "no_backend_available",
    message: expect.stringContaining("artbird: Artbird is offline"),
    recovery: "apple-container-local: run agentbrowse-infra enable",
  });
  expect(apple.events).toEqual(["probe"]);
});

test("authentication and image failures never fall through", async () => {
  const authentication = new FleetBackend("artbird");
  authentication.probeError = new CliError(
    "browser_host_authentication_failed",
    "authentication failed",
  );
  const apple = new FleetBackend("apple-container-local");
  await expect(
    fleet([authentication, apple]).provisionProfile({ profile: "auth" }),
  ).rejects.toMatchObject({
    code: "browser_host_authentication_failed",
  });
  expect(apple.events).toEqual([]);

  const wrongEngine = new FleetBackend("artbird");
  wrongEngine.probeError = new CliError("wrong_docker_engine", "wrong engine");
  const engineApple = new FleetBackend("apple-container-local");
  await expect(
    fleet([wrongEngine, engineApple]).provisionProfile({ profile: "engine" }),
  ).rejects.toMatchObject({ code: "wrong_docker_engine" });
  expect(engineApple.events).toEqual([]);

  const image = new FleetBackend("artbird");
  image.imagePresent = false;
  const otherApple = new FleetBackend("apple-container-local");
  await expect(
    fleet([image, otherApple]).provisionProfile({ profile: "image" }),
  ).rejects.toMatchObject({
    code: "image_missing",
  });
  expect(otherApple.events).toEqual([]);
});

test("an availability-shaped error after possible mutation never falls through", async () => {
  const artbird = new FleetBackend("artbird");
  artbird.runError = new CliError("browser_host_unreachable", "connection lost after run");
  const apple = new FleetBackend("apple-container-local");

  await expect(
    fleet([artbird, apple]).provisionProfile({ profile: "testing" }),
  ).rejects.toMatchObject({
    code: "browser_host_unreachable",
  });
  expect(artbird.state).toBeDefined();
  expect(apple.events).toEqual([]);
});

test("a possible first mutation reserves the profile home across retries", async () => {
  const directory = runtimeDir();
  const artbird = new FleetBackend("artbird");
  artbird.runError = new CliError("browser_host_unreachable", "connection lost after run");
  const apple = new FleetBackend("apple-container-local");
  const local = fleet([artbird, apple], directory);

  await expect(local.provisionProfile({ profile: "testing" })).rejects.toMatchObject({
    code: "browser_host_unreachable",
  });

  artbird.runError = null;
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  artbird.events.splice(0);
  apple.events.splice(0);
  await expect(local.provisionProfile({ profile: "testing" })).rejects.toMatchObject({
    code: "browser_host_unreachable",
  });
  expect(artbird.events).toEqual(["probe"]);
  expect(apple.events).toEqual([]);
});

test("existing target drift never falls through", async () => {
  const artbird = new FleetBackend("artbird");
  await fleet([artbird]).provisionProfile({ profile: "testing" });
  artbird.verifyError = new CliError("browser_drift", "ownership changed");
  artbird.events.splice(0);
  const apple = new FleetBackend("apple-container-local");

  await expect(
    fleet([artbird, apple]).provisionProfile({ profile: "testing" }),
  ).rejects.toMatchObject({
    code: "browser_drift",
  });
  expect(apple.events).toEqual([]);
});

test("backend-bound receipt routes cleanup even when order changes", async () => {
  const directory = runtimeDir();
  const apple = new FleetBackend("apple-container-local");
  const launched = await fleet([apple], directory).provisionProfile({ profile: "testing" });
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  apple.events.splice(0);

  const result = await fleet([artbird, apple], directory).destroy(launched.name);

  expect(result.backend).toBe("apple-container-local");
  expect(apple.events).toContain("remove");
  expect(artbird.events).toEqual([]);
});

test("receiptless cleanup fails closed before listing an available backend", async () => {
  const apple = new FleetBackend("apple-container-local");
  const launched = await fleet([apple]).provisionProfile({ profile: "testing" });
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  apple.events.splice(0);

  await expect(fleet([apple, artbird]).destroy(launched.name)).rejects.toMatchObject({
    code: "cleanup_backend_unavailable",
    message: expect.stringContaining("without a backend-bound receipt"),
  });

  expect(artbird.events).toEqual(["probe"]);
  expect(apple.events).toEqual(["probe"]);
  expect(apple.state).toBeDefined();
});

test("explicit backend cleanup ignores an unrelated unavailable backend", async () => {
  const apple = new FleetBackend("apple-container-local");
  const launched = await fleet([apple]).provisionProfile({ profile: "testing" });
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  apple.events.splice(0);

  const result = await fleet([artbird, apple]).destroy(launched.name, apple.id);

  expect(result.backend).toBe("apple-container-local");
  expect(result.destroyed).toBe(true);
  expect(apple.events).toContain("remove");
  expect(artbird.events).toEqual([]);
});

test("local capacity refuses a second target before running another container", async () => {
  const apple = new FleetBackend("apple-container-local", 1);
  const local = fleet([apple]);
  await local.provisionProfile({ profile: "first" });
  apple.events.splice(0);

  await expect(local.provisionProfile({ profile: "second" })).rejects.toMatchObject({
    code: "backend_capacity_exhausted",
  });
  expect(apple.events).not.toContain("run");
});

test("a profile keeps its fallback backend home after its target closes", async () => {
  const directory = runtimeDir();
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  const apple = new FleetBackend("apple-container-local");
  const firstFleet = fleet([artbird, apple], directory);
  const first = await firstFleet.provisionProfile({ profile: "signed-in" });
  expect(first.backend).toBe("apple-container-local");
  await firstFleet.destroy(first.name, first.backend, first.profile);

  artbird.probeError = null;
  artbird.events.splice(0);
  apple.events.splice(0);
  const second = await fleet([artbird, apple], directory).provisionProfile({
    profile: "signed-in",
  });

  expect(second.backend).toBe("apple-container-local");
  expect(artbird.events).toEqual([]);
  expect(apple.events[0]).toBe("probe");
});

test("a stale close cannot clear a newer exact target binding", async () => {
  const directory = runtimeDir();
  const artbird = new FleetBackend("artbird");
  const local = fleet([artbird], directory);
  const first = await local.provisionProfile({ profile: "research" });
  await local.destroy(first.name, first.backend, first.profile);
  const second = await local.provisionProfile({ profile: "research" });

  const stale = await local.destroy(first.name, first.backend, first.profile);
  expect(stale.destroyed).toBe(false);
  expect((await local.targetForProfile("research"))?.name).toBe(second.name);
});

test("concurrent first bindings choose exactly one profile home", async () => {
  const store = new ProfileBindingStore(runtimeDir());
  const results = await Promise.allSettled([
    store.bindProfile("research", "artbird"),
    store.bindProfile("research", "apple-container-local"),
  ]);

  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const rejected = results.find((result) => result.status === "rejected");
  expect(rejected).toMatchObject({
    status: "rejected",
    reason: expect.objectContaining({ code: "profile_backend_mismatch" }),
  });
  const binding = await store.read("research");
  expect(binding).toBeDefined();
  expect(["artbird", "apple-container-local"]).toContain(binding!.backend);
});
