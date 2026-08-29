import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ContainerState,
  FarmBackend,
  ManagedContainerRecord,
  RunBrowserInput,
} from "../cli/backend.ts";
import { CliError } from "../cli/errors.ts";
import { BrowserFarm } from "../cli/farm.ts";
import { BrowserFleet } from "../cli/fleet.ts";
import type { BrowserAccess } from "../cli/model.ts";

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

  async listManagedContainers(): Promise<readonly ManagedContainerRecord[]> {
    this.events.push("list");
    if (this.state === undefined) return [];
    return [
      {
        name: this.state.labels["dev.agentbrowse.target"]!,
        slot: Number(this.state.labels["dev.agentbrowse.slot"]),
        container: this.state.labels["test.container"]!,
        state: this.state.running ? "running" : "stopped",
        status: this.state.running ? "Running" : "Stopped",
      },
    ];
  }

  async inspectContainer(): Promise<ContainerState | undefined> {
    this.events.push("inspect");
    return this.state;
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
        "dev.agentbrowse.slot": String(input.target.slot),
        "test.container": input.target.container,
      },
      environment: [],
      command: [],
      running: true,
      addresses: [],
      bindings: {},
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
  const result = await fleet([artbird, apple]).provision({ name: "testing" });

  expect(result.backend).toBe("artbird");
  expect(artbird.events).toContain("run");
  expect(apple.events).toEqual([]);
});

test("classified Artbird unavailability passively selects prepared Apple", async () => {
  const artbird = new FleetBackend("artbird");
  artbird.probeError = new CliError("browser_host_unreachable", "Artbird is offline");
  const apple = new FleetBackend("apple-container-local");

  const result = await fleet([artbird, apple]).provision({ name: "testing" });

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

  await expect(fleet([artbird, apple]).provision({ name: "testing" })).rejects.toMatchObject({
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
  await expect(fleet([authentication, apple]).provision({ name: "auth" })).rejects.toMatchObject({
    code: "browser_host_authentication_failed",
  });
  expect(apple.events).toEqual([]);

  const wrongEngine = new FleetBackend("artbird");
  wrongEngine.probeError = new CliError("wrong_docker_engine", "wrong engine");
  const engineApple = new FleetBackend("apple-container-local");
  await expect(
    fleet([wrongEngine, engineApple]).provision({ name: "engine" }),
  ).rejects.toMatchObject({ code: "wrong_docker_engine" });
  expect(engineApple.events).toEqual([]);

  const image = new FleetBackend("artbird");
  image.imagePresent = false;
  const otherApple = new FleetBackend("apple-container-local");
  await expect(fleet([image, otherApple]).provision({ name: "image" })).rejects.toMatchObject({
    code: "image_missing",
  });
  expect(otherApple.events).toEqual([]);
});

test("an availability-shaped error after possible mutation never falls through", async () => {
  const artbird = new FleetBackend("artbird");
  artbird.runError = new CliError("browser_host_unreachable", "connection lost after run");
  const apple = new FleetBackend("apple-container-local");

  await expect(fleet([artbird, apple]).provision({ name: "testing" })).rejects.toMatchObject({
    code: "browser_host_unreachable",
  });
  expect(artbird.state).toBeDefined();
  expect(apple.events).toEqual([]);
});

test("existing target drift never falls through", async () => {
  const artbird = new FleetBackend("artbird");
  await fleet([artbird]).provision({ name: "testing" });
  artbird.verifyError = new CliError("browser_drift", "ownership changed");
  artbird.events.splice(0);
  const apple = new FleetBackend("apple-container-local");

  await expect(fleet([artbird, apple]).provision({ name: "testing" })).rejects.toMatchObject({
    code: "browser_drift",
  });
  expect(apple.events).toEqual([]);
});

test("backend-bound receipt routes cleanup even when order changes", async () => {
  const directory = runtimeDir();
  const apple = new FleetBackend("apple-container-local");
  await fleet([apple], directory).provision({ name: "testing" });
  const artbird = new FleetBackend("artbird");

  const result = await fleet([artbird, apple], directory).destroy("testing");

  expect(result.backend).toBe("apple-container-local");
  expect(apple.events).toContain("remove");
  expect(artbird.events).toEqual([]);
});

test("local capacity refuses a second target before running another container", async () => {
  const apple = new FleetBackend("apple-container-local", 1);
  const local = fleet([apple]);
  await local.provision({ name: "first" });
  apple.events.splice(0);

  await expect(local.provision({ name: "second" })).rejects.toMatchObject({
    code: "backend_capacity_exhausted",
  });
  expect(apple.events).not.toContain("run");
});
