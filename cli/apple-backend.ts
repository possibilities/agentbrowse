import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import type { AgentbrowseConfig, AppleContainerBackendConfig } from "../config/deployment.ts";
import { KERNEL_HEADFUL_IMAGE_LOCK } from "../config/kernel-headful-image.ts";
import {
  type BackendCommand,
  browserEnvironment,
  type ContainerState,
  commandFailure,
  defaultBackendCommand,
  drift,
  type FarmBackend,
  isIpv4,
  type ManagedContainerRecord,
  type ManagedProfileRecord,
  type ProfileConsumerRecord,
  type ProfileState,
  type RunBrowserInput,
  validateReadyTimeout,
  verifyBrowserVideoEnvironment,
  verifyCommonOwnership,
} from "./backend.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserAccess,
  type BrowserProfile,
  PROFILE_MOUNT_PATH,
  PROFILE_SCHEMA_VERSION,
  profileFor,
  type Target,
} from "./model.ts";

const INFRA_MARKER = "agentbrowse-infra-owned-v1";
export const APPLE_NAT_WRAPPER =
  "set -- $(hostname -I); export NEKO_WEBRTC_NAT1TO1=$1; exec /wrapper";

export interface AppleContainerBackendDependencies {
  readonly command?: BackendCommand;
  readonly readText?: (path: string) => string;
  readonly uniqueSuffix?: () => string;
  readonly probe?: (url: string) => Promise<boolean>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

type JsonObject = Record<string, unknown>;

export class AppleContainerFarmBackend implements FarmBackend {
  readonly id: string;
  readonly type = "apple-container" as const;
  readonly maxTargets: number;
  private readonly runCommand: BackendCommand;
  private readonly readText: (path: string) => string;
  private readonly uniqueSuffix: () => string;
  private readonly probe: (url: string) => Promise<boolean>;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    readonly backendConfig: AppleContainerBackendConfig,
    readonly config: AgentbrowseConfig,
    dependencies: AppleContainerBackendDependencies = {},
  ) {
    this.id = backendConfig.id;
    this.maxTargets = backendConfig.maxTargets;
    this.runCommand = dependencies.command ?? defaultBackendCommand;
    this.readText = dependencies.readText ?? ((path) => readFileSync(path, "utf8"));
    this.uniqueSuffix =
      dependencies.uniqueSuffix ?? (() => crypto.randomUUID().replaceAll("-", "").slice(0, 10));
    this.probe = dependencies.probe ?? probeUrl;
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  newContainerName(name: string): string {
    return `agentbrowse-browser-${name}-${this.uniqueSuffix()}`;
  }

  async verifyHost(signal?: AbortSignal): Promise<void> {
    const result = await this.runCommand([this.backendConfig.command, "system", "status"], signal);
    const output = `${result.stdout}\n${result.stderr}`.trim();
    if (/apiserver is not running/i.test(output)) {
      throw new CliError(
        "apple_service_stopped",
        "local Apple container service is disabled",
        "run agentbrowse-infra enable, then prepare the locked image explicitly",
      );
    }
    if (result.exitCode !== 0) throw commandFailure("Apple container system status", result);
    if (!output.includes("apiserver is running")) {
      throw new CliError(
        "apple_service_stopped",
        "local Apple container service is disabled",
        "run agentbrowse-infra enable, then prepare the locked image explicitly",
      );
    }
    const applicationRoot = /^application data root:\s*(.+?)\/?$/m.exec(output)?.[1];
    if (applicationRoot === undefined) {
      throw new CliError(
        "invalid_apple_response",
        "Apple container did not report its application-data root",
      );
    }
    if (applicationRoot !== this.backendConfig.applicationRoot.replace(/\/$/, "")) {
      throw new CliError(
        "apple_application_root_mismatch",
        `Apple container is using ${applicationRoot}, not ${this.backendConfig.applicationRoot}`,
      );
    }
    const markerPath = `${dirname(this.backendConfig.applicationRoot)}/OWNED`;
    let marker: string;
    try {
      marker = this.readText(markerPath).trim();
    } catch {
      throw new CliError(
        "apple_ownership_missing",
        `Apple container application root has no agentbrowse-infra ownership marker at ${markerPath}`,
      );
    }
    if (marker !== INFRA_MARKER) {
      throw new CliError(
        "apple_ownership_mismatch",
        `Apple container application root has an invalid ownership marker at ${markerPath}`,
      );
    }
  }

  async resolveImage(override?: string): Promise<string> {
    return (
      override ?? this.config.images.defaultImage ?? KERNEL_HEADFUL_IMAGE_LOCK.runtimeReference
    );
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.runCommand([this.backendConfig.command, "image", "inspect", image]);
    return result.exitCode === 0 && result.stdout !== "[]";
  }

  async listManagedProfiles(signal?: AbortSignal): Promise<readonly ManagedProfileRecord[]> {
    const result = await this.runCommand(
      [this.backendConfig.command, "volume", "list", "--format", "json"],
      signal,
    );
    if (result.exitCode !== 0) throw commandFailure("Apple container volume list", result);
    const rows = jsonArray(result.stdout, "Apple container volume list");
    const profiles: ManagedProfileRecord[] = [];
    for (const row of rows) {
      if (!isObject(row)) {
        throw new CliError("invalid_apple_response", "Apple container volume list is malformed");
      }
      const labels = stringRecord(row.labels);
      if (
        labels["dev.agentbrowse.managed"] !== "true" ||
        labels["dev.agentbrowse.role"] !== "browser-profile" ||
        labels["dev.agentbrowse.backend"] !== this.id
      ) {
        continue;
      }
      const name = labels["dev.agentbrowse.profile"];
      const volume = row.name;
      if (
        name === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        volume !== `agentbrowse-profile-${name}`
      ) {
        throw new CliError(
          "invalid_apple_response",
          "managed Apple Browser profile labels are malformed",
        );
      }
      profiles.push({ name, volume });
    }
    return profiles;
  }

  async inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined> {
    const result = await this.runCommand([
      this.backendConfig.command,
      "volume",
      "inspect",
      profile.volume,
    ]);
    if (result.exitCode !== 0) {
      if (/not found|no such volume/i.test(`${result.stderr}\n${result.stdout}`)) return undefined;
      throw commandFailure("Apple container volume inspect", result);
    }
    const rows = jsonArray(result.stdout, `Apple container volume inspect ${profile.volume}`);
    if (rows.length === 0) return undefined;
    if (rows.length !== 1 || !isObject(rows[0])) {
      throw new CliError(
        "invalid_apple_response",
        `Apple container returned ambiguous inspect data for ${profile.volume}`,
      );
    }
    const row = rows[0];
    if (typeof row.name !== "string" || typeof row.driver !== "string") {
      throw new CliError(
        "invalid_apple_response",
        `Apple container returned incomplete inspect data for ${profile.volume}`,
      );
    }
    return { volume: row.name, driver: row.driver, labels: stringRecord(row.labels) };
  }

  async createProfile(profile: BrowserProfile): Promise<void> {
    const result = await this.runCommand([
      this.backendConfig.command,
      "volume",
      "create",
      "--label",
      "dev.agentbrowse.managed=true",
      "--label",
      "dev.agentbrowse.role=browser-profile",
      "--label",
      `dev.agentbrowse.backend=${this.id}`,
      "--label",
      `dev.agentbrowse.profile=${profile.name}`,
      "--label",
      `dev.agentbrowse.profile.schema=${PROFILE_SCHEMA_VERSION}`,
      profile.volume,
    ]);
    if (result.exitCode !== 0) throw commandFailure("Apple container volume create", result);
  }

  async listProfileConsumers(
    profile: BrowserProfile,
    signal?: AbortSignal,
  ): Promise<readonly ProfileConsumerRecord[]> {
    const result = await this.runCommand(
      [this.backendConfig.command, "list", "--all", "--quiet"],
      signal,
    );
    if (result.exitCode !== 0) throw commandFailure("Apple container list", result);
    if (result.stdout === "") return [];
    const consumers: ProfileConsumerRecord[] = [];
    for (const container of result.stdout.split("\n")) {
      const state = await this.inspectContainer(container);
      if (
        state?.mounts.some(
          (mount) =>
            mount.type === "volume" &&
            mount.name === profile.volume &&
            mount.destination === PROFILE_MOUNT_PATH,
        )
      ) {
        consumers.push({ container, state: state.running ? "running" : "stopped" });
      }
    }
    return consumers;
  }

  async removeProfile(profile: BrowserProfile): Promise<void> {
    const result = await this.runCommand([
      this.backendConfig.command,
      "volume",
      "delete",
      profile.volume,
    ]);
    if (result.exitCode !== 0) throw commandFailure("Apple container volume delete", result);
  }

  async listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]> {
    const result = await this.runCommand(
      [this.backendConfig.command, "list", "--all", "--quiet"],
      signal,
    );
    if (result.exitCode !== 0) throw commandFailure("Apple container list", result);
    if (result.stdout === "") return [];
    const records: ManagedContainerRecord[] = [];
    for (const container of result.stdout.split("\n")) {
      const state = await this.inspectContainer(container);
      if (state === undefined) {
        throw new CliError(
          "invalid_apple_response",
          `Apple container ${container} disappeared during inventory`,
        );
      }
      if (
        state.labels["dev.agentbrowse.managed"] !== "true" ||
        state.labels["dev.agentbrowse.role"] !== "kernel-browser" ||
        state.labels["dev.agentbrowse.backend"] !== this.id
      ) {
        throw new CliError(
          "apple_foreign_container",
          `Apple container ${container} is not an owned ${this.id} Browser target`,
          "run agentbrowse-infra disable only after resolving the foreign resource",
        );
      }
      const name = state.labels["dev.agentbrowse.target"];
      const profile = state.labels["dev.agentbrowse.profile"];
      const slot = state.labels["dev.agentbrowse.slot"];
      if (
        name === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        profile === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(profile) ||
        slot === undefined ||
        !/^(0|[1-9][0-9]{0,2})$/.test(slot)
      ) {
        throw new CliError(
          "invalid_apple_response",
          "managed Apple container labels are malformed",
        );
      }
      records.push({
        name,
        profile,
        slot: Number(slot),
        container,
        state: state.running ? "running" : "stopped",
        status: state.running ? "Running" : "Stopped",
      });
    }
    return records;
  }

  async inspectContainer(container: string): Promise<ContainerState | undefined> {
    const result = await this.runCommand([this.backendConfig.command, "inspect", container]);
    if (result.exitCode !== 0) throw commandFailure("Apple container inspect", result);
    let rows: unknown;
    try {
      rows = JSON.parse(result.stdout);
    } catch {
      throw new CliError(
        "invalid_apple_response",
        `Apple container returned invalid inspect data for ${container}`,
      );
    }
    if (!Array.isArray(rows)) {
      throw new CliError(
        "invalid_apple_response",
        `Apple container returned non-array inspect data for ${container}`,
      );
    }
    if (rows.length === 0) return undefined;
    if (rows.length !== 1 || !isObject(rows[0])) {
      throw new CliError(
        "invalid_apple_response",
        `Apple container returned ambiguous inspect data for ${container}`,
      );
    }
    return parseAppleInspect(rows[0], container);
  }

  async verifyContainer(state: ContainerState, target: Target, image: string): Promise<void> {
    verifyCommonOwnership(state, target);
    if (state.labels["dev.agentbrowse.image"] !== image) {
      drift(`${target.container} uses a different image`);
    }
    if (!state.environment.includes("ENABLE_WEBRTC=true")) {
      drift(`${target.container} does not enable Live View`);
    }
    if (!state.environment.includes(`NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`)) {
      drift(`${target.container} uses a different WebRTC mux port`);
    }
    verifyBrowserVideoEnvironment(
      state,
      this.backendConfig.video ?? this.config.browser.video,
      target.container,
    );
    if (!state.command.includes(APPLE_NAT_WRAPPER)) {
      drift(`${target.container} does not discover its Direct address for Neko`);
    }
    directAddress(state, target.container);
  }

  async browserAccess(target: Target, suppliedState?: ContainerState): Promise<BrowserAccess> {
    const state = suppliedState ?? (await this.inspectContainer(target.container));
    if (state === undefined) {
      throw new CliError("browser_missing", `${target.container} is absent from Apple container`);
    }
    const address = directAddress(state, target.container);
    return {
      cdpUrl: `http://${address}:9222`,
      liveViewUrl: `http://${address}:8080`,
      liveViewAccess: { mode: "direct", baseUrl: `http://${address}:8080` },
    };
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    const { target, image, nekoLogLevel } = input;
    const profile = profileFor(target.profile);
    const args = [
      this.backendConfig.command,
      "run",
      "--detach",
      "--name",
      target.container,
      "--label",
      "dev.agentbrowse.managed=true",
      "--label",
      "dev.agentbrowse.role=kernel-browser",
      "--label",
      `dev.agentbrowse.backend=${this.id}`,
      "--label",
      `dev.agentbrowse.target=${target.name}`,
      "--label",
      `dev.agentbrowse.profile=${profile.name}`,
      "--label",
      `dev.agentbrowse.slot=${target.slot}`,
      "--label",
      `dev.agentbrowse.image=${image}`,
      "--platform",
      "linux/amd64",
      "--rosetta",
      "--cpus",
      String(this.backendConfig.cpus),
      "--memory",
      this.backendConfig.memory,
      "--tmpfs",
      "/dev/shm",
      "--mount",
      `type=volume,source=${profile.volume},target=${PROFILE_MOUNT_PATH}`,
      ...browserEnvironment(
        target,
        null,
        nekoLogLevel,
        this.config.browser.timezone,
        this.backendConfig.video ?? this.config.browser.video,
      ),
      "--entrypoint",
      "/bin/sh",
      image,
      "-c",
      APPLE_NAT_WRAPPER,
    ];
    const result = await this.runCommand(args);
    if (result.exitCode !== 0) throw commandFailure("Apple container run", result);
  }

  async startContainer(container: string): Promise<void> {
    const result = await this.runCommand([this.backendConfig.command, "start", container]);
    if (result.exitCode !== 0) throw commandFailure("Apple container start", result);
  }

  async waitReady(target: Target, timeoutSeconds = 120): Promise<void> {
    validateReadyTimeout(timeoutSeconds);
    const deadline = Date.now() + timeoutSeconds * 1_000;
    while (Date.now() < deadline) {
      const access = await this.browserAccess(target);
      if (
        (await this.probe(`${access.liveViewUrl}/`)) &&
        (await this.probe(`${access.cdpUrl}/json/version`))
      ) {
        return;
      }
      await this.sleep(250);
    }
    throw new CliError(
      "browser_not_ready",
      `${target.container} did not make CDP and Live View ready within ${timeoutSeconds} seconds`,
    );
  }

  async removeContainer(container: string): Promise<void> {
    await this.runCommand([this.backendConfig.command, "stop", "--time", "5", container]);
    const result = await this.runCommand([
      this.backendConfig.command,
      "delete",
      "--force",
      container,
    ]);
    if (result.exitCode !== 0) throw commandFailure("Apple container delete", result);
  }

  missingImageRecovery(image: string): string {
    return `run agentbrowse-infra pull ${image}, or load the locked OCI archive explicitly`;
  }
}

function parseAppleInspect(row: JsonObject, container: string): ContainerState {
  const configuration = objectOrEmpty(row.configuration);
  const initProcess = objectOrEmpty(configuration.initProcess);
  const labels = stringRecord(configuration.labels);
  const environment = stringArray(initProcess.environment);
  const executable = typeof initProcess.executable === "string" ? [initProcess.executable] : [];
  const argumentsValue = stringArray(initProcess.arguments);
  const mounts = Array.isArray(configuration.mounts)
    ? configuration.mounts.flatMap(parseAppleMount)
    : [];
  const networks = Array.isArray(row.networks) ? row.networks : [];
  const addresses = networks.flatMap((network) => {
    if (!isObject(network) || typeof network.ipv4Address !== "string") return [];
    const address = network.ipv4Address.split("/")[0]!;
    return isIpv4(address) ? [address] : [];
  });
  const imageValue = configuration.image;
  const imageObject = objectOrEmpty(imageValue);
  const image =
    labels["dev.agentbrowse.image"] ??
    (typeof imageValue === "string" ? imageValue : undefined) ??
    (typeof imageObject.reference === "string" ? imageObject.reference : undefined);
  if (image === undefined || typeof row.status !== "string") {
    throw new CliError(
      "invalid_apple_response",
      `Apple container returned incomplete inspect data for ${container}`,
    );
  }
  return {
    image,
    labels,
    environment,
    command: [...executable, ...argumentsValue],
    running: row.status === "running",
    addresses,
    bindings: {},
    mounts,
  };
}

function parseAppleMount(value: unknown) {
  if (!isObject(value)) return [];
  const type = objectOrEmpty(value.type);
  const volume = objectOrEmpty(type.volume);
  if (typeof volume.name !== "string" || typeof value.destination !== "string") return [];
  const options = stringArray(value.options);
  return [
    {
      type: "volume",
      name: volume.name,
      destination: value.destination,
      writable: !options.includes("ro"),
    },
  ];
}

function directAddress(state: ContainerState, container: string): string {
  const address = state.addresses[0];
  if (address === undefined) {
    throw new CliError(
      "invalid_apple_response",
      `Apple container ${container} has no Direct IPv4 address`,
    );
  }
  return address;
}

function objectOrEmpty(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") output[key] = entry;
  }
  return output;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonArray(source: string, operation: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError("invalid_apple_response", `${operation} returned invalid JSON`);
  }
  if (!Array.isArray(value)) {
    throw new CliError("invalid_apple_response", `${operation} returned a non-array response`);
  }
  return value;
}

async function probeUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.ok;
  } catch {
    return false;
  }
}
