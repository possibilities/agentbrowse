import { homedir } from "node:os";
import { join } from "node:path";

import { CliError } from "./errors.ts";
import type { Target } from "./model.ts";

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
  tailnetIp: string;
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
  verifyHost(): Promise<void>;
  resolveTailnetIp(): Promise<string>;
  resolveImage(override?: string): Promise<string>;
  imageExists(image: string): Promise<boolean>;
  listManagedContainers(): Promise<readonly ManagedContainerRecord[]>;
  inspectContainer(container: string): Promise<ContainerState | undefined>;
  runBrowser(input: RunBrowserInput): Promise<void>;
  startContainer(container: string): Promise<void>;
  waitReady(container: string): Promise<void>;
  removeContainer(container: string): Promise<void>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
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

async function command(args: readonly string[]): Promise<CommandResult> {
  const child = Bun.spawn([...args], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

function failure(commandName: string, result: CommandResult): CliError {
  const detail = result.stderr || result.stdout || `exit ${result.exitCode}`;
  return new CliError("command_failed", `${commandName} failed: ${detail}`);
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
  readonly remoteHost: string;
  readonly sourceDir: string;

  constructor(readonly env: Readonly<Record<string, string | undefined>> = process.env) {
    this.context = env.AGENTBROWSE_DOCKER_CONTEXT ?? "artbird";
    this.remoteHost = env.AGENTBROWSE_REMOTE_HOST ?? "artbird";
    this.sourceDir = env.AGENTBROWSE_KERNEL_IMAGES ?? join(homedir(), "src", "kernel-images");
  }

  async verifyHost(): Promise<void> {
    const context = await command([
      "docker",
      "context",
      "inspect",
      this.context,
      "--format",
      "{{ .Endpoints.docker.Host }}",
    ]);
    if (context.exitCode !== 0) throw failure("docker context inspect", context);
    if (context.stdout !== "ssh://artbird") {
      throw new CliError(
        "wrong_docker_context",
        `Docker context ${this.context} targets ${context.stdout || "nothing"}, not ssh://artbird`,
      );
    }

    const engine = await command([
      "docker",
      "--context",
      this.context,
      "info",
      "--format",
      "{{ .Name }}",
    ]);
    if (engine.exitCode !== 0) throw failure("docker info", engine);
    if (engine.stdout !== "artbird") {
      throw new CliError(
        "wrong_docker_engine",
        `Docker context ${this.context} reached ${engine.stdout || "an unnamed engine"}, not artbird`,
      );
    }
  }

  async resolveTailnetIp(): Promise<string> {
    const configured = this.env.AGENTBROWSE_ARTBIRD_IP;
    if (configured !== undefined) {
      if (!isIpv4(configured)) {
        throw new CliError("invalid_tailnet_ip", `invalid Artbird IPv4 address: ${configured}`);
      }
      return configured;
    }
    const result = await command([
      "ssh",
      "-o",
      "BatchMode=yes",
      this.remoteHost,
      "tailscale ip -4",
    ]);
    if (result.exitCode !== 0) throw failure("Artbird Tailnet address lookup", result);
    const ip = result.stdout.split("\n")[0] ?? "";
    if (!isIpv4(ip)) {
      throw new CliError("invalid_tailnet_ip", "could not resolve Artbird's Tailnet IPv4 address");
    }
    return ip;
  }

  async resolveImage(override?: string): Promise<string> {
    const configured = override ?? this.env.AGENTBROWSE_IMAGE;
    if (configured !== undefined && configured.trim() !== "") return configured;
    const revision = await command([
      "git",
      "-C",
      this.sourceDir,
      "rev-parse",
      "--short=12",
      "HEAD",
    ]);
    if (revision.exitCode !== 0) {
      throw new CliError(
        "kernel_images_unavailable",
        `kernel-images checkout is unavailable at ${this.sourceDir}`,
        "set --image or AGENTBROWSE_IMAGE to an image already loaded on Artbird",
      );
    }
    return `agentbrowse/kernel-headful:${revision.stdout}`;
  }

  async imageExists(image: string): Promise<boolean> {
    const result = await command(["docker", "--context", this.context, "image", "inspect", image]);
    return result.exitCode === 0;
  }

  async listManagedContainers(): Promise<readonly ManagedContainerRecord[]> {
    const format = [
      '{{.Label "dev.agentbrowse.target"}}',
      '{{.Label "dev.agentbrowse.slot"}}',
      "{{.Names}}",
      "{{.State}}",
      "{{.Status}}",
    ].join("\t");
    const result = await command([
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
    ]);
    if (result.exitCode !== 0) throw failure("docker container list", result);
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
    const result = await command([
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
    const { target, image, tailnetIp, nekoLogLevel } = input;
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
      `${tailnetIp}:${target.webrtcPort}:${target.webrtcPort}/udp`,
      "--publish",
      `${tailnetIp}:${target.cdpPort}:9222`,
      "--env",
      "DISPLAY_NUM=1",
      "--env",
      "HEIGHT=1080",
      "--env",
      "WIDTH=1920",
      "--env",
      "TZ=America/New_York",
      "--env",
      "RUN_AS_ROOT=false",
      "--env",
      "ENABLE_WEBRTC=true",
      "--env",
      `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
      "--env",
      `NEKO_WEBRTC_NAT1TO1=${tailnetIp}`,
      "--env",
      `NEKO_LOG_LEVEL=${nekoLogLevel}`,
      image,
    ];
    const result = await command(args);
    if (result.exitCode !== 0) throw failure("docker run", result);
  }

  async startContainer(container: string): Promise<void> {
    const result = await command(["docker", "--context", this.context, "start", container]);
    if (result.exitCode !== 0) throw failure("docker start", result);
  }

  async waitReady(container: string): Promise<void> {
    const probe =
      "attempt=0; " +
      "until curl --fail --silent --max-time 3 http://127.0.0.1:8080/ >/dev/null && " +
      "curl --fail --silent --max-time 3 http://127.0.0.1:9222/json/version >/dev/null; " +
      'do attempt=$((attempt + 1)); [ "$attempt" -ge 120 ] && exit 1; sleep 1; done';
    const result = await command([
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
        `${container} did not make CDP and Live View ready within 120 seconds`,
      );
    }
  }

  async removeContainer(container: string): Promise<void> {
    const result = await command(["docker", "--context", this.context, "rm", "--force", container]);
    if (result.exitCode !== 0) throw failure("docker rm", result);
  }
}
