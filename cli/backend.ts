import type { AgentbrowseConfig, DockerBackendConfig } from "../config/deployment.ts";
import { KERNEL_HEADFUL_IMAGE_LOCK } from "../config/kernel-headful-image.ts";
import { CliError } from "./errors.ts";
import {
  type BrowserAccess,
  type BrowserProfile,
  CHROMIUM_FLAGS,
  PROFILE_MOUNT_PATH,
  PROFILE_SCHEMA_VERSION,
  profileFor,
  type Target,
  targetFor,
} from "./model.ts";

export interface ContainerMount {
  type: string;
  name: string | null;
  destination: string;
  writable: boolean;
}

export interface ContainerState {
  image: string;
  labels: Readonly<Record<string, string>>;
  environment: readonly string[];
  command: readonly string[];
  running: boolean;
  addresses: readonly string[];
  bindings: Readonly<Record<string, readonly PortBinding[] | undefined>>;
  mounts: readonly ContainerMount[];
}

export interface ProfileState {
  volume: string;
  driver: string;
  labels: Readonly<Record<string, string>>;
}

export interface PortBinding {
  hostIp: string;
  hostPort: string;
}

export interface RunBrowserInput {
  target: Target;
  image: string;
  nekoLogLevel: string;
}

export interface ManagedContainerRecord {
  name: string;
  profile: string | null;
  slot: number;
  container: string;
  state: string;
  status: string;
}

export interface ManagedProfileRecord {
  name: string;
  volume: string;
}

export interface ProfileConsumerRecord {
  container: string;
  state: string;
}

export interface FarmBackend {
  readonly id: string;
  readonly type: "docker" | "apple-container";
  readonly maxTargets: number;
  newContainerName(name: string): string;
  verifyHost(signal?: AbortSignal): Promise<void>;
  resolveImage(override?: string): Promise<string>;
  imageExists(image: string): Promise<boolean>;
  listManagedProfiles(signal?: AbortSignal): Promise<readonly ManagedProfileRecord[]>;
  inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined>;
  createProfile(profile: BrowserProfile): Promise<void>;
  listProfileConsumers(
    profile: BrowserProfile,
    signal?: AbortSignal,
  ): Promise<readonly ProfileConsumerRecord[]>;
  removeProfile(profile: BrowserProfile): Promise<void>;
  listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]>;
  inspectContainer(container: string): Promise<ContainerState | undefined>;
  verifyContainer(state: ContainerState, target: Target, image: string): Promise<void>;
  browserAccess(target: Target, state?: ContainerState): Promise<BrowserAccess>;
  runBrowser(input: RunBrowserInput): Promise<void>;
  startContainer(container: string): Promise<void>;
  waitReady(target: Target, timeoutSeconds?: number): Promise<void>;
  removeContainer(container: string): Promise<void>;
  missingImageRecovery(image: string): string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type BackendCommand = (
  args: readonly string[],
  signal?: AbortSignal,
) => Promise<CommandResult>;

export interface DockerFarmBackendDependencies {
  readonly command?: BackendCommand;
}

interface DockerInspect {
  Config?: {
    Image?: string;
    Labels?: Record<string, string> | null;
    Env?: string[] | null;
    Cmd?: string[] | null;
    Entrypoint?: string[] | null;
  };
  State?: { Running?: boolean };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
  Mounts?: Array<{
    Type?: string;
    Name?: string;
    Destination?: string;
    RW?: boolean;
  }> | null;
}

interface DockerVolumeInspect {
  Name?: string;
  Driver?: string;
  Labels?: Record<string, string> | null;
}

export async function defaultBackendCommand(
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  signal?.throwIfAborted();
  const child = Bun.spawn([...args], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    ...(signal === undefined ? {} : { signal }),
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal?.throwIfAborted();
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

export function commandFailure(commandName: string, result: CommandResult): CliError {
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  return new CliError("command_failed", `${commandName} failed: ${detail}`);
}

function remoteFailure(commandName: string, result: CommandResult): CliError {
  const detail = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /permission denied|authentication failed|no supported authentication methods|publickey/.test(
      detail,
    )
  ) {
    return new CliError("browser_host_authentication_failed", "Browser host authentication failed");
  }
  if (
    /could not resolve hostname|name or service not known|nodename nor servname provided|temporary failure in name resolution|lookup .+ no such host/.test(
      detail,
    )
  ) {
    return new CliError("browser_host_unresolved", "Browser host could not be resolved");
  }
  if (
    /cannot connect to (the )?docker daemon|is the docker daemon running|docker daemon is not running|error response from daemon/.test(
      detail,
    )
  ) {
    return new CliError("browser_service_unavailable", "Browser service is unavailable");
  }
  if (/connection refused/.test(detail)) {
    return new CliError(
      "browser_host_not_accepting_connections",
      "Browser host is not accepting connections",
    );
  }
  if (
    /no route to host|network is unreachable|host is down|operation timed out|connection timed out|i\/o timeout|context deadline exceeded/.test(
      detail,
    )
  ) {
    return browserHostUnreachable();
  }
  return commandFailure(commandName, result);
}

function browserHostUnreachable(): CliError {
  return new CliError("browser_host_unreachable", "Browser host is offline or unreachable");
}

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  );
}

function normalizedBindings(inspect: DockerInspect): Record<string, readonly PortBinding[]> {
  const output: Record<string, readonly PortBinding[]> = {};
  for (const [port, bindings] of Object.entries(inspect.HostConfig?.PortBindings ?? {})) {
    output[port] = (bindings ?? []).map((binding) => ({
      hostIp: binding.HostIp ?? "",
      hostPort: binding.HostPort ?? "",
    }));
  }
  return output;
}

function normalizedMounts(inspect: DockerInspect): readonly ContainerMount[] {
  return (inspect.Mounts ?? []).map((mount) => ({
    type: mount.Type ?? "",
    name: mount.Name ?? null,
    destination: mount.Destination ?? "",
    writable: mount.RW === true,
  }));
}

function hasBinding(
  state: ContainerState,
  port: string,
  hostIp: string,
  hostPort: number,
): boolean {
  return (state.bindings[port] ?? []).some(
    (binding) => binding.hostIp === hostIp && binding.hostPort === String(hostPort),
  );
}

function hasProfileMount(state: ContainerState, profile: BrowserProfile): boolean {
  return state.mounts.some(
    (mount) =>
      mount.type === "volume" &&
      mount.name === profile.volume &&
      mount.destination === PROFILE_MOUNT_PATH &&
      mount.writable,
  );
}

export function verifyCommonOwnership(state: ContainerState, target: Target, image?: string): void {
  const profile = profileForTarget(target);
  if (state.labels["dev.agentbrowse.managed"] !== "true") {
    drift(`${target.container} is not managed by agentbrowse`);
  }
  if (state.labels["dev.agentbrowse.role"] !== "kernel-browser") {
    drift(`${target.container} has a different agentbrowse role`);
  }
  if (state.labels["dev.agentbrowse.backend"] !== target.backend) {
    drift(`${target.container} belongs to a different backend`);
  }
  if (state.labels["dev.agentbrowse.target"] !== target.name) {
    drift(`${target.container} belongs to a different browser target`);
  }
  if (state.labels["dev.agentbrowse.profile"] !== target.profile) {
    drift(`${target.container} uses a different browser profile`);
  }
  if (state.labels["dev.agentbrowse.slot"] !== String(target.slot)) {
    drift(`${target.container} uses a different slot`);
  }
  if (image !== undefined && state.image !== image) {
    drift(`${target.container} uses a different image`);
  }
  if (!hasProfileMount(state, profile)) {
    drift(`${target.container} does not have the expected writable browser profile mount`);
  }
}

export function drift(message: string): never {
  throw new CliError(
    "browser_drift",
    message,
    "destroy the browser target explicitly before recreating it",
  );
}

function profileForTarget(target: Target): BrowserProfile {
  return profileFor(target.profile);
}

export class DockerFarmBackend implements FarmBackend {
  readonly id: string;
  readonly type = "docker" as const;
  readonly maxTargets = 1_000;
  readonly context: string;
  readonly remoteHost: string;
  private readonly runCommand: BackendCommand;

  constructor(
    readonly backendConfig: DockerBackendConfig,
    readonly config: AgentbrowseConfig,
    dependencies: DockerFarmBackendDependencies = {},
  ) {
    this.id = backendConfig.id;
    this.context = backendConfig.context;
    this.remoteHost = backendConfig.remoteHost;
    this.runCommand = dependencies.command ?? defaultBackendCommand;
  }

  newContainerName(name: string): string {
    return `agentbrowse-browser-${name}`;
  }

  async verifyHost(signal?: AbortSignal): Promise<void> {
    const context = await this.runCommand(
      ["docker", "context", "inspect", this.context, "--format", "{{ .Endpoints.docker.Host }}"],
      signal,
    );
    if (context.exitCode !== 0) throw commandFailure("docker context inspect", context);
    if (
      this.backendConfig.expectedEndpoint !== null &&
      context.stdout !== this.backendConfig.expectedEndpoint
    ) {
      throw new CliError(
        "wrong_docker_context",
        `Docker context ${this.context} does not target its configured endpoint`,
      );
    }

    const engine = await this.discoveryCommand(
      ["docker", "--context", this.context, "info", "--format", "{{ .Name }}"],
      signal,
    );
    if (engine.exitCode !== 0) throw remoteFailure("docker info", engine);
    if (
      this.backendConfig.expectedEngine !== null &&
      engine.stdout !== this.backendConfig.expectedEngine
    ) {
      throw new CliError(
        "wrong_docker_engine",
        `Docker context ${this.context} reached a different engine than configured`,
      );
    }
  }

  async resolveNetworkAddress(signal?: AbortSignal): Promise<string> {
    if (this.backendConfig.networkAddress !== null) {
      if (!isIpv4(this.backendConfig.networkAddress)) {
        throw new CliError(
          "invalid_network_address",
          `invalid browser network address: ${this.backendConfig.networkAddress}`,
        );
      }
      return this.backendConfig.networkAddress;
    }
    const result = await this.discoveryCommand(
      ["ssh", "-o", "BatchMode=yes", this.remoteHost, this.backendConfig.networkAddressCommand!],
      signal,
    );
    if (result.exitCode !== 0) throw remoteFailure("browser network address lookup", result);
    const ip = result.stdout.split("\n")[0] ?? "";
    if (!isIpv4(ip)) {
      throw new CliError(
        "invalid_network_address",
        "Browser host returned an invalid network address",
      );
    }
    return ip;
  }

  async resolveImage(override?: string): Promise<string> {
    return (
      override ?? this.config.images.defaultImage ?? KERNEL_HEADFUL_IMAGE_LOCK.runtimeReference
    );
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "image",
      "inspect",
      image,
    ]);
    return result.exitCode === 0;
  }

  async listManagedProfiles(signal?: AbortSignal): Promise<readonly ManagedProfileRecord[]> {
    const format = [
      '{{.Label "dev.agentbrowse.profile"}}',
      '{{.Label "dev.agentbrowse.backend"}}',
      "{{.Name}}",
    ].join("\t");
    const result = await this.discoveryCommand(
      [
        "docker",
        "--context",
        this.context,
        "volume",
        "list",
        "--filter",
        "label=dev.agentbrowse.managed=true",
        "--filter",
        "label=dev.agentbrowse.role=browser-profile",
        "--filter",
        `label=dev.agentbrowse.backend=${this.id}`,
        "--format",
        format,
      ],
      signal,
    );
    if (result.exitCode !== 0) throw remoteFailure("docker volume list", result);
    if (result.stdout === "") return [];

    return result.stdout.split("\n").map((line) => {
      const [name, backend, volume] = line.split("\t");
      if (
        name === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        backend !== this.id ||
        volume !== `agentbrowse-profile-${name}`
      ) {
        throw new CliError(
          "invalid_docker_response",
          "managed browser profile labels are malformed",
        );
      }
      return { name, volume };
    });
  }

  async inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "volume",
      "inspect",
      profile.volume,
    ]);
    if (result.exitCode !== 0) {
      if (/no such volume/i.test(`${result.stderr}\n${result.stdout}`)) return undefined;
      throw commandFailure("docker volume inspect", result);
    }
    let rows: DockerVolumeInspect[];
    try {
      rows = JSON.parse(result.stdout) as DockerVolumeInspect[];
    } catch {
      throw new CliError(
        "invalid_docker_response",
        `Docker returned invalid inspect data for ${profile.volume}`,
      );
    }
    const inspect = rows[0];
    if (inspect?.Name === undefined || inspect.Driver === undefined) {
      throw new CliError(
        "invalid_docker_response",
        `Docker returned incomplete inspect data for ${profile.volume}`,
      );
    }
    return {
      volume: inspect.Name,
      driver: inspect.Driver,
      labels: inspect.Labels ?? {},
    };
  }

  async createProfile(profile: BrowserProfile): Promise<void> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
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
    if (result.exitCode !== 0) throw commandFailure("docker volume create", result);
  }

  async listProfileConsumers(
    profile: BrowserProfile,
    signal?: AbortSignal,
  ): Promise<readonly ProfileConsumerRecord[]> {
    const format = ["{{.Names}}", "{{.State}}"].join("\t");
    const result = await this.discoveryCommand(
      [
        "docker",
        "--context",
        this.context,
        "container",
        "list",
        "--all",
        "--filter",
        `volume=${profile.volume}`,
        "--format",
        format,
      ],
      signal,
    );
    if (result.exitCode !== 0) throw commandFailure("docker container list", result);
    if (result.stdout === "") return [];
    return result.stdout.split("\n").map((line) => {
      const [container, state] = line.split("\t");
      if (container === undefined || container === "" || state === undefined || state === "") {
        throw new CliError("invalid_docker_response", "browser profile consumers are malformed");
      }
      return { container, state };
    });
  }

  async removeProfile(profile: BrowserProfile): Promise<void> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "volume",
      "rm",
      profile.volume,
    ]);
    if (result.exitCode !== 0) throw commandFailure("docker volume rm", result);
  }

  async listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]> {
    const format = [
      '{{.Label "dev.agentbrowse.target"}}',
      '{{.Label "dev.agentbrowse.profile"}}',
      '{{.Label "dev.agentbrowse.slot"}}',
      '{{.Label "dev.agentbrowse.backend"}}',
      "{{.Names}}",
      "{{.State}}",
      "{{.Status}}",
    ].join("\t");
    const result = await this.discoveryCommand(
      [
        "docker",
        "--context",
        this.context,
        "container",
        "list",
        "--all",
        "--filter",
        "label=dev.agentbrowse.managed=true",
        "--filter",
        "label=dev.agentbrowse.role=kernel-browser",
        "--filter",
        `label=dev.agentbrowse.backend=${this.id}`,
        "--format",
        format,
      ],
      signal,
    );
    if (result.exitCode !== 0) throw remoteFailure("docker container list", result);
    if (result.stdout === "") return [];

    return result.stdout.split("\n").map((line) => {
      const [name, profileValue, slotValue, backend, container, state, status] = line.split("\t");
      if (
        name === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        profileValue === undefined ||
        (profileValue !== "" && !/^[a-z][a-z0-9-]{0,31}$/.test(profileValue)) ||
        slotValue === undefined ||
        !/^(0|[1-9][0-9]{0,2})$/.test(slotValue) ||
        backend !== this.id ||
        container === undefined ||
        state === undefined ||
        status === undefined
      ) {
        throw new CliError("invalid_docker_response", "managed browser labels are malformed");
      }
      return {
        name,
        profile: profileValue === "" ? null : profileValue,
        slot: Number(slotValue),
        container,
        state,
        status,
      };
    });
  }

  async inspectContainer(container: string): Promise<ContainerState | undefined> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "container",
      "inspect",
      container,
    ]);
    if (result.exitCode !== 0) {
      if (result.stderr.includes("No such object") || result.stderr.includes("No such container")) {
        return undefined;
      }
      throw commandFailure("docker container inspect", result);
    }
    let rows: DockerInspect[];
    try {
      rows = JSON.parse(result.stdout) as DockerInspect[];
    } catch {
      throw new CliError(
        "invalid_docker_response",
        `Docker returned invalid inspect data for ${container}`,
      );
    }
    const inspect = rows[0];
    if (inspect === undefined || inspect.Config?.Image === undefined) {
      throw new CliError(
        "invalid_docker_response",
        `Docker returned incomplete inspect data for ${container}`,
      );
    }
    return {
      image: inspect.Config.Image,
      labels: inspect.Config.Labels ?? {},
      environment: inspect.Config.Env ?? [],
      command: [...(inspect.Config.Entrypoint ?? []), ...(inspect.Config.Cmd ?? [])],
      running: inspect.State?.Running === true,
      addresses: [],
      bindings: normalizedBindings(inspect),
      mounts: normalizedMounts(inspect),
    };
  }

  async verifyContainer(state: ContainerState, target: Target, image: string): Promise<void> {
    verifyCommonOwnership(state, target, image);
    const networkAddress = await this.resolveNetworkAddress();
    if (!state.environment.includes("ENABLE_WEBRTC=true")) {
      drift(`${target.container} does not enable Live View`);
    }
    if (!state.environment.includes(`CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`)) {
      drift(`${target.container} uses different Chromium window flags`);
    }
    if (!state.environment.includes(`NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`)) {
      drift(`${target.container} uses a different WebRTC mux port`);
    }
    if (!state.environment.includes(`NEKO_WEBRTC_NAT1TO1=${networkAddress}`)) {
      drift(`${target.container} uses a different WebRTC NAT address`);
    }
    if (!hasBinding(state, "8080/tcp", "127.0.0.1", target.httpPort)) {
      drift(`${target.container} uses a different Live View HTTP bind`);
    }
    if (!hasBinding(state, `${target.webrtcPort}/udp`, networkAddress, target.webrtcPort)) {
      drift(`${target.container} uses a different WebRTC bind`);
    }
    if (!hasBinding(state, "9222/tcp", networkAddress, target.cdpPort)) {
      drift(`${target.container} uses a different CDP bind`);
    }
  }

  async browserAccess(target: Target): Promise<BrowserAccess> {
    const networkAddress = await this.resolveNetworkAddress();
    return {
      cdpUrl: `http://${networkAddress}:${target.cdpPort}`,
      liveViewUrl: `http://127.0.0.1:${target.httpPort}`,
      liveViewAccess: {
        mode: "ssh",
        remoteHost: this.remoteHost,
        remotePort: target.httpPort,
      },
    };
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    const { target, image, nekoLogLevel } = input;
    const profile = profileForTarget(target);
    const networkAddress = await this.resolveNetworkAddress();
    const args = [
      "docker",
      "--context",
      this.context,
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
      "--platform",
      "linux/amd64",
      "--privileged",
      "--tmpfs",
      "/dev/shm:rw,size=2g",
      "--memory",
      "8g",
      "--mount",
      `type=volume,src=${profile.volume},dst=${PROFILE_MOUNT_PATH}`,
      "--publish",
      `127.0.0.1:${target.httpPort}:8080`,
      "--publish",
      `${networkAddress}:${target.webrtcPort}:${target.webrtcPort}/udp`,
      "--publish",
      `${networkAddress}:${target.cdpPort}:9222`,
      ...browserEnvironment(target, networkAddress, nekoLogLevel, this.config.browser.timezone),
      image,
    ];
    const result = await this.runCommand(args);
    if (result.exitCode !== 0) throw commandFailure("docker run", result);
  }

  async startContainer(container: string): Promise<void> {
    const result = await this.runCommand(["docker", "--context", this.context, "start", container]);
    if (result.exitCode !== 0) throw commandFailure("docker start", result);
  }

  async waitReady(target: Target, timeoutSeconds = 120): Promise<void> {
    validateReadyTimeout(timeoutSeconds);
    const probe =
      "attempt=0; " +
      "until curl --fail --silent --max-time 3 http://127.0.0.1:8080/ >/dev/null && " +
      "curl --fail --silent --max-time 3 http://127.0.0.1:9222/json/version >/dev/null; " +
      `do attempt=$((attempt + 1)); [ "$attempt" -ge ${timeoutSeconds} ] && exit 1; sleep 1; done`;
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "exec",
      target.container,
      "sh",
      "-c",
      probe,
    ]);
    if (result.exitCode !== 0) {
      throw new CliError(
        "browser_not_ready",
        `${target.container} did not make CDP and Live View ready within ${timeoutSeconds} seconds`,
      );
    }
  }

  async removeContainer(container: string): Promise<void> {
    const result = await this.runCommand([
      "docker",
      "--context",
      this.context,
      "rm",
      "--force",
      container,
    ]);
    if (result.exitCode !== 0) throw commandFailure("docker rm", result);
  }

  missingImageRecovery(): string {
    return "load the locked image on the Docker host, or select one with --image";
  }

  private async discoveryCommand(
    args: readonly string[],
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    if (signal === undefined) return await this.runCommand(args);
    signal.throwIfAborted();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        const error = browserHostUnreachable();
        controller.abort(error);
        reject(error);
      }, this.config.discovery.commandTimeoutMs);
    });
    try {
      return await Promise.race([this.runCommand(args, controller.signal), deadline]);
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (timedOut) throw browserHostUnreachable();
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    }
  }
}

export function browserEnvironment(
  target: Target,
  networkAddress: string | null,
  nekoLogLevel: string,
  timezone: string | null,
): string[] {
  return [
    "--env",
    "DISPLAY_NUM=1",
    "--env",
    "HEIGHT=1080",
    "--env",
    "WIDTH=1920",
    "--env",
    "RUN_AS_ROOT=false",
    "--env",
    `CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`,
    "--env",
    "ENABLE_WEBRTC=true",
    "--env",
    `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
    ...(networkAddress === null ? [] : ["--env", `NEKO_WEBRTC_NAT1TO1=${networkAddress}`]),
    "--env",
    `NEKO_LOG_LEVEL=${nekoLogLevel}`,
    ...(timezone === null ? [] : ["--env", `TZ=${timezone}`]),
  ];
}

export function targetFromLabels(
  name: string,
  backend: string,
  container: string,
  state: ContainerState,
): Target {
  const slot = state.labels["dev.agentbrowse.slot"];
  if (slot === undefined || !/^(0|[1-9][0-9]{0,2})$/.test(slot)) {
    throw new CliError(
      "foreign_container",
      `refusing to delete ${container}: its slot ownership label is invalid`,
    );
  }
  const profile = state.labels["dev.agentbrowse.profile"];
  if (profile === undefined || !/^[a-z][a-z0-9-]{0,31}$/.test(profile)) {
    throw new CliError(
      "foreign_container",
      `refusing to delete ${container}: its browser profile ownership label is invalid`,
    );
  }
  return targetFor(name, Number(slot), { backend, container, profile });
}

export function verifyDestroyOwnership(state: ContainerState, target: Target): void {
  try {
    verifyCommonOwnership(state, target);
  } catch {
    throw new CliError(
      "foreign_container",
      `refusing to delete ${target.container}: its ownership labels do not match ${target.name}`,
    );
  }
}

export function validateReadyTimeout(timeoutSeconds: number): void {
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
    throw new CliError(
      "invalid_ready_timeout",
      `browser readiness timeout must be from 1 to 120 seconds: ${timeoutSeconds}`,
    );
  }
}
