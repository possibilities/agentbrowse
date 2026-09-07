import type { BrowserVideoConfig } from "../config/deployment.ts";
import { CliError } from "./errors.ts";
import type { KernelBrowser } from "./kernel.ts";
import {
  type BrowserAccess,
  type BrowserProfile,
  CHROMIUM_FLAGS,
  PROFILE_DATA_PATH,
  PROFILE_MOUNT_PATH,
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
  readonly type: "hypeman";
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
  removeContainer(container: string, force?: boolean): Promise<void>;
  withKernel<T>(target: Target, operation: (kernel: KernelBrowser) => Promise<T>): Promise<T>;
  missingImageRecovery(image: string): string;
}

export function isIpv4(value: string): boolean {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255)
  );
}

function hasProfileMount(state: ContainerState, profile: BrowserProfile): boolean {
  return state.mounts.some(
    (mount) =>
      mount.type === "volume" &&
      mount.name === profile.volume &&
      (mount.destination === PROFILE_MOUNT_PATH ||
        (state.labels["dev.agentbrowse.profile.layout"] === undefined &&
          mount.destination === PROFILE_DATA_PATH)) &&
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

export function browserEnvironment(
  target: Target,
  networkAddress: string | null,
  nekoLogLevel: string,
  timezone: string | null,
  video: BrowserVideoConfig,
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
    ...browserVideoVariables(video).flatMap((variable) => ["--env", variable]),
    "--env",
    `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
    ...(networkAddress === null ? [] : ["--env", `NEKO_WEBRTC_NAT1TO1=${networkAddress}`]),
    "--env",
    `NEKO_LOG_LEVEL=${nekoLogLevel}`,
    ...(timezone === null ? [] : ["--env", `TZ=${timezone}`]),
  ];
}

export function browserVideoVariables(video: BrowserVideoConfig): string[] {
  const pipeline = (showPointer: boolean) => ({
    fps: String(video.fps),
    gst_encoder: "vp8enc",
    gst_params: {
      "target-bitrate": `round(${video.targetBitrateBps})`,
      "cpu-used": String(video.cpuUsed),
      "end-usage": "cbr",
      threads: String(video.threads),
      deadline: "1",
      undershoot: "95",
      "buffer-size": "(3072 * 4)",
      "buffer-initial-size": "(3072 * 2)",
      "buffer-optimal-size": "(3072 * 3)",
      "keyframe-max-dist": String(video.keyframeMaxDistance),
      "min-quantizer": "4",
      "max-quantizer": "20",
    },
    show_pointer: showPointer,
  });
  const pipelines = canonicalJson({ legacy: pipeline(true), main: pipeline(false) });
  return [
    `NEKO_DESKTOP_SCREEN=1920x1080@${video.screenRefreshRate}`,
    "NEKO_CAPTURE_VIDEO_IDS=main",
    `NEKO_CAPTURE_VIDEO_PIPELINES=${pipelines}`,
  ];
}

export function verifyBrowserVideoEnvironment(
  state: ContainerState,
  video: BrowserVideoConfig,
  container: string,
): void {
  if (!browserVideoVariables(video).every((variable) => state.environment.includes(variable))) {
    drift(`${container} uses different Live View capture settings`);
  }
  if (
    state.environment.some(
      (variable) => variable.startsWith("NEKO_SCREEN=") || variable.startsWith("NEKO_LEGACY="),
    )
  ) {
    drift(`${container} overrides Live View capture compatibility settings`);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJson(entry)]),
  );
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
