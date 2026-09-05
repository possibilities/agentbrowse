import { readFileSync } from "node:fs";
import type { AgentbrowseConfig, HypemanBackendConfig } from "../config/deployment.ts";
import { KERNEL_HEADFUL_IMAGE_LOCK } from "../config/kernel-headful-image.ts";
import {
  browserEnvironment,
  type ContainerState,
  drift,
  type FarmBackend,
  isIpv4,
  type ManagedContainerRecord,
  type ManagedProfileRecord,
  type ProfileConsumerRecord,
  type ProfileState,
  type RunBrowserInput,
  targetFromLabels,
  validateReadyTimeout,
  verifyBrowserVideoEnvironment,
  verifyCommonOwnership,
  verifyDestroyOwnership,
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

type Row = Record<string, unknown>;
export type HypemanRequest = (
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => Promise<unknown>;

// Hypeman's guest init supplies the Linux VM. Mount shared memory explicitly and
// discover the VM address only when the deployment does not advertise a relay.
export const HYPEMAN_WRAPPER =
  'set -e; rm -f /var/run/supervisor.sock /var/run/supervisord.pid /run/dbus/system_bus_socket /tmp/pulse/native; chown 0:0 /usr/bin/mount /opt/chrome-for-testing/chrome_sandbox; chmod 4755 /opt/chrome-for-testing/chrome_sandbox; ln -sfn chrome_sandbox /opt/chrome-for-testing/chrome-sandbox; export CHROME_DEVEL_SANDBOX=/opt/chrome-for-testing/chrome_sandbox; mountpoint -q /dev/shm || mount -t tmpfs -o mode=1777 tmpfs /dev/shm; if [ -z "$NEKO_WEBRTC_NAT1TO1" ]; then set -- $(hostname -I); export NEKO_WEBRTC_NAT1TO1=$1; fi; exec /wrapper';

function object(value: unknown): Row {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new CliError("invalid_hypeman_response", "Hypeman returned a malformed object");
  return value as Row;
}
function rows(value: unknown): Row[] {
  if (!Array.isArray(value))
    throw new CliError("invalid_hypeman_response", "Hypeman returned a malformed list");
  return value.map(object);
}
function string(value: unknown): string {
  if (typeof value !== "string")
    throw new CliError("invalid_hypeman_response", "Hypeman omitted a required string");
  return value;
}
function strings(value: unknown): Record<string, string> {
  const result = object(value ?? {});
  for (const v of Object.values(result)) string(v);
  return result as Record<string, string>;
}
function enc(value: string): string {
  return encodeURIComponent(value);
}

export class HypemanFarmBackend implements FarmBackend {
  readonly id: string;
  readonly type = "hypeman" as const;
  readonly maxTargets = 1000;
  private readonly request: HypemanRequest;
  private readonly observedIds = new Map<string, string>();

  constructor(
    readonly backendConfig: HypemanBackendConfig,
    readonly config: AgentbrowseConfig,
    request?: HypemanRequest,
  ) {
    this.id = backendConfig.id;
    this.request = request ?? this.httpRequest.bind(this);
  }

  private async httpRequest(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let token: string;
    try {
      token = readFileSync(this.backendConfig.tokenFile, "utf8").trim();
    } catch {
      throw new CliError(
        "hypeman_credentials_missing",
        `cannot read Hypeman token file for ${this.id}`,
      );
    }
    if (!token || /\s/.test(token))
      throw new CliError(
        "hypeman_credentials_missing",
        `invalid Hypeman token file for ${this.id}`,
      );
    const timeout = AbortSignal.timeout(
      method === "GET" && path === "/instances" ? this.config.discovery.commandTimeoutMs : 120_000,
    );
    let response: Response;
    try {
      response = await fetch(this.backendConfig.baseUrl + path, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        redirect: "error",
      });
    } catch {
      signal?.throwIfAborted();
      throw new CliError("browser_host_unreachable", `Hypeman backend ${this.id} is unreachable`);
    }
    if (response.status === 404) return undefined;
    if (response.status === 401 || response.status === 403)
      throw new CliError(
        "browser_host_authentication_failed",
        `Hypeman authentication failed for ${this.id}`,
      );
    if (!response.ok)
      throw new CliError(
        "hypeman_request_failed",
        `Hypeman ${method} ${path} failed (HTTP ${response.status}): ${(await response.text()).slice(0, 1000)}`,
      );
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new CliError("invalid_hypeman_response", "Hypeman returned invalid JSON");
    }
  }

  newContainerName(name: string): string {
    return `ab-${name}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  }
  async verifyHost(signal?: AbortSignal): Promise<void> {
    rows(await this.request("GET", "/instances", undefined, signal));
  }
  async resolveImage(override?: string): Promise<string> {
    return (
      override ?? this.config.images.defaultImage ?? KERNEL_HEADFUL_IMAGE_LOCK.runtimeReference
    );
  }
  async imageExists(image: string): Promise<boolean> {
    const result = await this.request("GET", `/images/${enc(image)}`);
    return result !== undefined && object(result).status === "ready";
  }
  private owned(tags: Record<string, string>, role: string): boolean {
    return (
      tags["dev.agentbrowse.managed"] === "true" &&
      tags["dev.agentbrowse.backend"] === this.id &&
      tags["dev.agentbrowse.role"] === role
    );
  }
  private profileTags(profile: BrowserProfile): Record<string, string> {
    return {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.backend": this.id,
      "dev.agentbrowse.role": "browser-profile",
      "dev.agentbrowse.profile": profile.name,
      "dev.agentbrowse.profile.schema": String(PROFILE_SCHEMA_VERSION),
    };
  }
  private async volumes(signal?: AbortSignal): Promise<Row[]> {
    return rows(await this.request("GET", "/volumes", undefined, signal));
  }
  private async volume(profile: BrowserProfile): Promise<Row | undefined> {
    const matches = (await this.volumes()).filter((v) => v.name === profile.volume);
    if (matches.length > 1)
      throw new CliError("profile_conflict", `multiple Hypeman volumes named ${profile.volume}`);
    return matches[0];
  }
  async listManagedProfiles(signal?: AbortSignal): Promise<readonly ManagedProfileRecord[]> {
    return (await this.volumes(signal))
      .filter((v) => this.owned(strings(v.tags), "browser-profile"))
      .map((v) => {
        const name = string(strings(v.tags)["dev.agentbrowse.profile"]);
        if (profileFor(name).volume !== v.name)
          throw new CliError("profile_drift", "Hypeman profile name disagrees with its tags");
        return { name, volume: string(v.name) };
      });
  }
  async inspectProfile(profile: BrowserProfile): Promise<ProfileState | undefined> {
    const v = await this.volume(profile);
    return v === undefined
      ? undefined
      : { volume: string(v.name), driver: "hypeman", labels: strings(v.tags) };
  }
  async createProfile(profile: BrowserProfile): Promise<void> {
    await this.request("POST", "/volumes", {
      name: profile.volume,
      size_gb: this.backendConfig.profileSizeGb,
      tags: this.profileTags(profile),
    });
  }
  async listProfileConsumers(
    profile: BrowserProfile,
    signal?: AbortSignal,
  ): Promise<readonly ProfileConsumerRecord[]> {
    const v = await this.volume(profile);
    if (v === undefined) return [];
    // Inspect all instances, including foreign and stopped ones, before a writable mount.
    return rows(await this.request("GET", "/instances", undefined, signal))
      .filter((i) => rows(i.volumes ?? []).some((m) => m.volume_id === v.id))
      .map((i) => ({ container: string(i.name), state: string(i.state).toLowerCase() }));
  }
  async removeProfile(profile: BrowserProfile): Promise<void> {
    const v = await this.volume(profile);
    if (v === undefined) return;
    const tags = strings(v.tags);
    if (Object.entries(this.profileTags(profile)).some(([k, value]) => tags[k] !== value))
      throw new CliError("profile_drift", "refusing to delete a foreign Hypeman volume");
    if ((await this.listProfileConsumers(profile)).length > 0)
      throw new CliError("profile_in_use", "Hypeman profile still has consumers");
    await this.request("DELETE", `/volumes/${enc(string(v.id))}`);
  }
  private async instance(container: string): Promise<Row | undefined> {
    const value = await this.request("GET", `/instances/${enc(container)}`);
    if (value === undefined) return undefined;
    const row = object(value);
    if (row.name !== container)
      throw new CliError("invalid_hypeman_response", "Hypeman returned a different instance");
    return row;
  }
  private state(row: Row, volumes: Row[]): ContainerState {
    const labels = strings(row.tags);
    const network = object(row.network ?? {});
    const address = network.ip;
    return {
      image: string(row.image),
      labels,
      running: row.state === "Running",
      bindings: {},
      addresses: typeof address === "string" && isIpv4(address) ? [address] : [],
      environment: Object.entries(strings(row.env)).map(([k, v]) => `${k}=${v}`),
      // Entrypoint is not exposed by Hypeman's instance API; the launch spec is
      // recorded in ownership tags and verified separately on reuse.
      command: [],
      mounts: rows(row.volumes ?? []).map((m) => ({
        type: "volume",
        name: (volumes.find((v) => v.id === m.volume_id)?.name as string) ?? null,
        destination: string(m.mount_path),
        writable: m.readonly !== true,
      })),
    };
  }
  async inspectContainer(container: string): Promise<ContainerState | undefined> {
    const i = await this.instance(container);
    if (i === undefined) return undefined;
    this.observedIds.set(container, string(i.id));
    return this.state(i, await this.volumes());
  }
  async listManagedContainers(signal?: AbortSignal): Promise<readonly ManagedContainerRecord[]> {
    return rows(await this.request("GET", "/instances", undefined, signal))
      .filter((i) => this.owned(strings(i.tags), "kernel-browser"))
      .map((i) => {
        const tags = strings(i.tags);
        const name = string(tags["dev.agentbrowse.target"]);
        const container = string(i.name);
        const target = targetFromLabels(name, this.id, container, {
          labels: tags,
        } as ContainerState);
        return {
          name,
          container,
          profile: target.profile,
          slot: target.slot,
          state: string(i.state).toLowerCase(),
          status: string(i.state),
        };
      });
  }
  async verifyContainer(state: ContainerState, target: Target, image: string): Promise<void> {
    verifyCommonOwnership(state, target, image);
    verifyBrowserVideoEnvironment(
      state,
      this.backendConfig.video ?? this.config.browser.video,
      target.container,
    );
    if (
      state.labels["dev.agentbrowse.hypeman.spec"] !== "1" ||
      state.labels["dev.agentbrowse.port-offset"] !== String(this.backendConfig.portOffset)
    )
      drift("Hypeman target uses a different launch specification");
    for (const expected of [
      "ENABLE_WEBRTC=true",
      `NEKO_WEBRTC_UDPMUX=${target.webrtcPort + this.backendConfig.portOffset}`,
      `NEKO_WEBRTC_NAT1TO1=${this.backendConfig.networkAddress ?? "127.0.0.1"}`,
    ]) {
      if (!state.environment.includes(expected))
        drift(`Hypeman target has incompatible browser transport: ${expected}`);
    }
  }
  async browserAccess(target: Target, suppliedState?: ContainerState): Promise<BrowserAccess> {
    const state = suppliedState ?? (await this.inspectContainer(target.container));
    if (!state) throw new CliError("browser_missing", "Hypeman Browser target is absent");
    const { remoteHost, networkAddress, portOffset } = this.backendConfig;
    const ip = state.addresses[0];
    if (!ip)
      throw new CliError(
        "invalid_hypeman_response",
        "Hypeman instance has no private IPv4 address",
      );
    if (remoteHost !== null && networkAddress !== null) {
      return {
        cdpUrl: `http://${networkAddress}:${target.cdpPort + portOffset}`,
        liveViewUrl: `http://${ip}:8080`,
        liveViewAccess: { mode: "ssh", remoteHost, remotePort: 8080, remoteAddress: ip },
      };
    }
    return {
      cdpUrl: `http://127.0.0.1:${target.cdpPort + portOffset}`,
      liveViewUrl: `http://127.0.0.1:${target.httpPort + portOffset}`,
      liveViewAccess: {
        mode: "direct",
        baseUrl: `http://127.0.0.1:${target.httpPort + portOffset}`,
      },
    };
  }
  async runBrowser({ target, image, nekoLogLevel }: RunBrowserInput): Promise<void> {
    const profile = await this.volume(profileFor(target.profile));
    if (!profile) throw new CliError("profile_missing", "Hypeman profile volume is absent");
    const envArgs = browserEnvironment(
      { ...target, webrtcPort: target.webrtcPort + this.backendConfig.portOffset },
      this.backendConfig.networkAddress ?? "127.0.0.1",
      nekoLogLevel,
      this.config.browser.timezone,
      this.backendConfig.video ?? this.config.browser.video,
    );
    const env = Object.fromEntries(
      envArgs
        .filter((_, index) => index % 2 === 1)
        .map((v) => {
          const split = v.indexOf("=");
          return [v.slice(0, split), v.slice(split + 1)];
        }),
    );
    const tags = {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "kernel-browser",
      "dev.agentbrowse.backend": this.id,
      "dev.agentbrowse.target": target.name,
      "dev.agentbrowse.profile": target.profile,
      "dev.agentbrowse.slot": String(target.slot),
      "dev.agentbrowse.hypeman.spec": "1",
      "dev.agentbrowse.port-offset": String(this.backendConfig.portOffset),
    };
    await this.request("POST", "/instances", {
      name: target.container,
      image,
      platform: "linux/amd64",
      size: this.backendConfig.memory,
      vcpus: this.backendConfig.cpus,
      tags,
      env,
      volumes: [{ volume_id: string(profile.id), mount_path: PROFILE_MOUNT_PATH, readonly: false }],
      entrypoint: ["/bin/sh", "-c"],
      cmd: [HYPEMAN_WRAPPER],
      skip_kernel_headers: true,
    });
    await this.syncNetwork();
  }
  async startContainer(container: string): Promise<void> {
    const i = await this.instance(container);
    if (!i || !this.owned(strings(i.tags), "kernel-browser"))
      throw new CliError("foreign_container", "Hypeman instance ownership is missing");
    const expected = this.observedIds.get(container);
    if (expected !== undefined && i.id !== expected)
      throw new CliError("foreign_container", "Hypeman instance incarnation changed before start");
    await this.request("POST", `/instances/${enc(string(i.id))}/start`, {});
    await this.syncNetwork();
  }
  async waitReady(target: Target, timeoutSeconds = 120): Promise<void> {
    validateReadyTimeout(timeoutSeconds);
    const deadline = Date.now() + timeoutSeconds * 1000;
    const access = await this.browserAccess(target);
    while (Date.now() < deadline) {
      try {
        // Remote Live View travels through SSH and is checked by the viewer.
        const response = await fetch(`${access.cdpUrl}/json/version`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok && typeof object(await response.json()).webSocketDebuggerUrl === "string") {
          if (this.backendConfig.remoteHost !== null) return;
          const view = await fetch(access.liveViewUrl, { signal: AbortSignal.timeout(2000) });
          await view.body?.cancel();
          if (view.ok) return;
        }
      } catch {
        /* guest may still be booting */
      }
      await Bun.sleep(500);
    }
    throw new CliError(
      "browser_not_ready",
      `Hypeman Browser target ${target.name} did not become ready within ${timeoutSeconds} seconds`,
    );
  }
  async removeContainer(container: string): Promise<void> {
    const expected = this.observedIds.get(container);
    const i = await this.instance(container);
    if (!i) return;
    if (expected !== undefined && i.id !== expected)
      throw new CliError(
        "foreign_container",
        "Hypeman instance incarnation changed before deletion",
      );
    const state = this.state(i, await this.volumes());
    const target = targetFromLabels(
      string(state.labels["dev.agentbrowse.target"]),
      this.id,
      container,
      state,
    );
    verifyDestroyOwnership(state, target);
    await this.request("DELETE", `/instances/${enc(string(i.id))}`);
    await this.syncNetwork();
  }
  private async syncNetwork(): Promise<void> {
    if (this.backendConfig.remoteHost === null) return;
    const child = Bun.spawn(
      [
        "ssh",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        this.backendConfig.remoteHost,
        "sudo",
        "-n",
        "/usr/local/bin/agentbrowse-hypeman",
        "network-sync",
      ],
      { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
    );
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text(),
    ]);
    if (code !== 0)
      throw new CliError(
        "hypeman_network_failed",
        `Hypeman network forwarding failed: ${stderr.slice(0, 1000)}`,
      );
  }
  missingImageRecovery(image: string): string {
    return `prepare this backend explicitly with agentbrowse-hypeman pull ${image}`;
  }
}
