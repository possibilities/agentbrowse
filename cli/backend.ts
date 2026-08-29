import type { AgentbrowseConfig } from "../config/deployment.ts";
import { requireConfigured } from "../config/deployment.ts";
import { KERNEL_HEADFUL_IMAGE_LOCK } from "../config/kernel-headful-image.ts";
import { CliError } from "./errors.ts";
import { CHROMIUM_FLAGS, type Target } from "./model.ts";

export interface ContainerState {
  image: string;
  labels: Readonly<Record<string, string>>;
  environment: readonly string[];
  running: boolean;
  bindings: Readonly<Record<string, readonly PortBinding[] | undefined>>;
}

export interface PortBinding {
  hostIp: string;
  hostPort: string;
}

export interface RunBrowserInput {
  target: Target;
  image: string;
  networkAddress: string;
  nekoLogLevel: string;
}

export interface ManagedContainerRecord {
  name: string;
  slot: number;
  container: string;
  state: string;
  status: string;
}

export interface FarmBackend {
  verifyHost(signal?: AbortSignal): Promise<void>;
  resolveNetworkAddress(signal?: AbortSignal): Promise<string>;
  resolveImage(override?: string): Promise<string>;
  imageExists(image: string): Promise<boolean>;
  listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]>;
  inspectContainer(container: string): Promise<ContainerState | undefined>;
  runBrowser(input: RunBrowserInput): Promise<void>;
  startContainer(container: string): Promise<void>;
  waitReady(container: string, timeoutSeconds?: number): Promise<void>;
  removeContainer(container: string): Promise<void>;
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
  };
  State?: { Running?: boolean };
  HostConfig?: {
    PortBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null> | null;
  };
}

async function defaultCommand(
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

function failure(commandName: string, result: CommandResult): CliError {
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
  return failure(commandName, result);
}

function browserHostUnreachable(): CliError {
  return new CliError("browser_host_unreachable", "Browser host is offline or unreachable");
}

function isIpv4(value: string): boolean {
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

export class DockerFarmBackend implements FarmBackend {
  readonly context: string;
  readonly remoteHost: string | null;
  private readonly runCommand: BackendCommand;

  constructor(
    readonly config: AgentbrowseConfig,
    dependencies: DockerFarmBackendDependencies = {},
  ) {
    this.context = requireConfigured(
      config.docker.context,
      "docker.context",
      "AGENTBROWSE_DOCKER_CONTEXT",
      config.path,
    );
    this.remoteHost = config.remote.host;
    this.runCommand = dependencies.command ?? defaultCommand;
  }

  async verifyHost(signal?: AbortSignal): Promise<void> {
    const context = await this.runCommand(
      ["docker", "context", "inspect", this.context, "--format", "{{ .Endpoints.docker.Host }}"],
      signal,
    );
    if (context.exitCode !== 0) throw failure("docker context inspect", context);
    if (
      this.config.docker.expectedEndpoint !== null &&
      context.stdout !== this.config.docker.expectedEndpoint
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
      this.config.docker.expectedEngine !== null &&
      engine.stdout !== this.config.docker.expectedEngine
    ) {
      throw new CliError(
        "wrong_docker_engine",
        `Docker context ${this.context} reached a different engine than configured`,
      );
    }
  }

  async resolveNetworkAddress(signal?: AbortSignal): Promise<string> {
    const configured = this.config.remote.networkAddress;
    if (configured !== null) {
      if (!isIpv4(configured)) {
        throw new CliError(
          "invalid_network_address",
          `invalid browser network address: ${configured}`,
        );
      }
      return configured;
    }
    const remoteHost = requireConfigured(
      this.remoteHost,
      "remote.host",
      "AGENTBROWSE_REMOTE_HOST",
      this.config.path,
    );
    const addressCommand = requireConfigured(
      this.config.remote.networkAddressCommand,
      "remote.networkAddressCommand",
      "AGENTBROWSE_NETWORK_ADDRESS_COMMAND",
      this.config.path,
    );
    const result = await this.discoveryCommand(
      ["ssh", "-o", "BatchMode=yes", remoteHost, addressCommand],
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
    const configured = override ?? this.config.images.defaultImage;
    if (configured !== undefined && configured !== null && configured.trim() !== "") {
      return configured;
    }
    return KERNEL_HEADFUL_IMAGE_LOCK.runtimeReference;
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

  async listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]> {
    const format = [
      '{{.Label "dev.agentbrowse.target"}}',
      '{{.Label "dev.agentbrowse.slot"}}',
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
        "--format",
        format,
      ],
      signal,
    );
    if (result.exitCode !== 0) throw remoteFailure("docker container list", result);
    if (result.stdout === "") return [];

    return result.stdout.split("\n").map((line) => {
      const [name, slotValue, container, state, status] = line.split("\t");
      if (
        name === undefined ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(name) ||
        slotValue === undefined ||
        !/^(0|[1-9][0-9]{0,2})$/.test(slotValue) ||
        container === undefined ||
        state === undefined ||
        status === undefined
      ) {
        throw new CliError("invalid_docker_response", "managed browser labels are malformed");
      }
      return { name, slot: Number(slotValue), container, state, status };
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
      throw failure("docker container inspect", result);
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
      running: inspect.State?.Running === true,
      bindings: normalizedBindings(inspect),
    };
  }

  async runBrowser(input: RunBrowserInput): Promise<void> {
    const { target, image, networkAddress, nekoLogLevel } = input;
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
      `dev.agentbrowse.target=${target.name}`,
      "--label",
      `dev.agentbrowse.slot=${target.slot}`,
      "--platform",
      "linux/amd64",
      "--privileged",
      "--tmpfs",
      "/dev/shm:rw,size=2g",
      "--memory",
      "8g",
      "--publish",
      `127.0.0.1:${target.httpPort}:8080`,
      "--publish",
      `${networkAddress}:${target.webrtcPort}:${target.webrtcPort}/udp`,
      "--publish",
      `${networkAddress}:${target.cdpPort}:9222`,
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
      "--env",
      `NEKO_WEBRTC_NAT1TO1=${networkAddress}`,
      "--env",
      `NEKO_LOG_LEVEL=${nekoLogLevel}`,
      ...(this.config.browser.timezone === null
        ? []
        : ["--env", `TZ=${this.config.browser.timezone}`]),
      image,
    ];
    const result = await this.runCommand(args);
    if (result.exitCode !== 0) throw failure("docker run", result);
  }

  async startContainer(container: string): Promise<void> {
    const result = await this.runCommand(["docker", "--context", this.context, "start", container]);
    if (result.exitCode !== 0) throw failure("docker start", result);
  }

  async waitReady(container: string, timeoutSeconds = 120): Promise<void> {
    if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 120) {
      throw new CliError(
        "invalid_ready_timeout",
        `browser readiness timeout must be from 1 to 120 seconds: ${timeoutSeconds}`,
      );
    }
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
      container,
      "sh",
      "-c",
      probe,
    ]);
    if (result.exitCode !== 0) {
      throw new CliError(
        "browser_not_ready",
        `${container} did not make CDP and Live View ready within ${timeoutSeconds} seconds`,
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
    if (result.exitCode !== 0) throw failure("docker rm", result);
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
