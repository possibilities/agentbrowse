import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CliError } from "../cli/errors.ts";

export type AgentbrowseEnvironment = Readonly<Record<string, string | undefined>>;

export interface DockerBackendConfig {
  readonly id: string;
  readonly type: "docker";
  readonly context: string;
  readonly expectedEndpoint: string | null;
  readonly expectedEngine: string | null;
  readonly remoteHost: string;
  readonly networkAddress: string | null;
  readonly networkAddressCommand: string | null;
  readonly video?: BrowserVideoConfig;
}

export interface AppleContainerBackendConfig {
  readonly id: string;
  readonly type: "apple-container";
  readonly command: string;
  readonly applicationRoot: string;
  readonly maxTargets: 1;
  readonly cpus: 2;
  readonly memory: "6G";
  readonly video?: BrowserVideoConfig;
}

export type BackendConfig = DockerBackendConfig | AppleContainerBackendConfig;

export interface BrowserVideoConfig {
  readonly screenRefreshRate: number;
  readonly fps: number;
  readonly cpuUsed: number;
  readonly threads: number;
  readonly targetBitrateBps: number;
  readonly keyframeMaxDistance: number;
}

export interface AgentbrowseConfig {
  readonly version: 2;
  readonly path: string;
  readonly backends: readonly BackendConfig[];
  readonly images: { readonly defaultImage: string | null };
  readonly browser: {
    readonly nekoLogLevel: string;
    readonly timezone: string | null;
    readonly video: BrowserVideoConfig;
  };
  readonly provider: { readonly name: string; readonly description: string };
  readonly liveView: {
    readonly labelPrefix: string;
    readonly username: string;
    readonly password: string;
    readonly readOnly: boolean;
  };
  readonly discovery: { readonly commandTimeoutMs: number };
}

type JsonObject = Record<string, unknown>;

const DEFAULT_DISCOVERY_COMMAND_TIMEOUT_MS = 2_000;
const MIN_DISCOVERY_COMMAND_TIMEOUT_MS = 100;
const MAX_DISCOVERY_COMMAND_TIMEOUT_MS = 4_000;
const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const DEFAULT_BROWSER_VIDEO: BrowserVideoConfig = {
  screenRefreshRate: 60,
  fps: 30,
  cpuUsed: 4,
  threads: 4,
  targetBitrateBps: 2_396_160,
  keyframeMaxDistance: 30,
};

export function agentbrowseConfigPath(env: AgentbrowseEnvironment = process.env): string {
  const explicit = env.AGENTBROWSE_CONFIG;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) {
      throw invalidConfiguration("AGENTBROWSE_CONFIG must be an absolute path");
    }
    return explicit;
  }
  const configHome = env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  if (!isAbsolute(configHome)) {
    throw invalidConfiguration("XDG_CONFIG_HOME must be an absolute path");
  }
  return join(configHome, "agentbrowse", "config.json");
}

export function loadAgentbrowseConfig(
  env: AgentbrowseEnvironment = process.env,
): AgentbrowseConfig {
  const path = agentbrowseConfigPath(env);
  const root = readConfigFile(path);
  const images = objectValue(root, "images", path);
  const browser = objectValue(root, "browser", path);
  const browserVideo = objectValue(browser, "video", `${path}: browser`);
  const provider = objectValue(root, "provider", path);
  const liveView = objectValue(root, "liveView", path);
  const discovery = objectValue(root, "discovery", path);

  if (root.version === undefined && Object.keys(root).length > 0) {
    throw invalidConfiguration(`${path} must declare version 2`);
  }
  if (root.version !== undefined && root.version !== 2) {
    throw invalidConfiguration(`${path} has unsupported version ${String(root.version)}`);
  }

  const sharedVideo = configuredBrowserVideo(
    env,
    browserVideo,
    `${path}: browser.video`,
    DEFAULT_BROWSER_VIDEO,
  );

  return {
    version: 2,
    path,
    backends: parseBackends(root.backends, path, env, sharedVideo),
    images: {
      defaultImage: configuredString(env, "AGENTBROWSE_IMAGE", images, "defaultImage", path),
    },
    browser: {
      nekoLogLevel:
        configuredString(env, "AGENTBROWSE_NEKO_LOG_LEVEL", browser, "nekoLogLevel", path) ??
        "info",
      timezone: configuredString(env, "AGENTBROWSE_BROWSER_TIMEZONE", browser, "timezone", path),
      video: sharedVideo,
    },
    provider: {
      name:
        configuredString(env, "AGENTBROWSE_PROVIDER_NAME", provider, "name", path) ?? "agentbrowse",
      description:
        configuredString(env, "AGENTBROWSE_PROVIDER_DESCRIPTION", provider, "description", path) ??
        "Manage ordered Kernel browser backends",
    },
    liveView: {
      labelPrefix:
        configuredString(
          env,
          "AGENTBROWSE_CONNECTION_LABEL_PREFIX",
          liveView,
          "labelPrefix",
          path,
        ) ?? "agentbrowse",
      username:
        configuredString(env, "AGENTBROWSE_LIVE_VIEW_USERNAME", liveView, "username", path) ??
        "kernel",
      password:
        configuredString(env, "AGENTBROWSE_LIVE_VIEW_PASSWORD", liveView, "password", path) ??
        "admin",
      readOnly: configuredBoolean(
        env,
        "AGENTBROWSE_LIVE_VIEW_READ_ONLY",
        liveView,
        "readOnly",
        false,
        path,
      ),
    },
    discovery: {
      commandTimeoutMs: configuredInteger(
        env,
        "AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS",
        discovery,
        "commandTimeoutMs",
        DEFAULT_DISCOVERY_COMMAND_TIMEOUT_MS,
        MIN_DISCOVERY_COMMAND_TIMEOUT_MS,
        MAX_DISCOVERY_COMMAND_TIMEOUT_MS,
        path,
      ),
    },
  };
}

function configuredBrowserVideo(
  env: AgentbrowseEnvironment,
  object: JsonObject,
  path: string,
  fallback: BrowserVideoConfig,
): BrowserVideoConfig {
  const video = {
    screenRefreshRate: configuredScreenRefreshRate(env, object, path, fallback.screenRefreshRate),
    fps: configuredInteger(
      env,
      "AGENTBROWSE_BROWSER_VIDEO_FPS",
      object,
      "fps",
      fallback.fps,
      1,
      60,
      path,
    ),
    cpuUsed: configuredInteger(
      env,
      "AGENTBROWSE_BROWSER_VIDEO_CPU_USED",
      object,
      "cpuUsed",
      fallback.cpuUsed,
      1,
      16,
      path,
    ),
    threads: configuredInteger(
      env,
      "AGENTBROWSE_BROWSER_VIDEO_THREADS",
      object,
      "threads",
      fallback.threads,
      1,
      16,
      path,
    ),
    targetBitrateBps: configuredInteger(
      env,
      "AGENTBROWSE_BROWSER_VIDEO_TARGET_BITRATE_BPS",
      object,
      "targetBitrateBps",
      fallback.targetBitrateBps,
      250_000,
      20_000_000,
      path,
    ),
    keyframeMaxDistance: configuredInteger(
      env,
      "AGENTBROWSE_BROWSER_VIDEO_KEYFRAME_MAX_DISTANCE",
      object,
      "keyframeMaxDistance",
      fallback.keyframeMaxDistance,
      1,
      120,
      path,
    ),
  };
  if (video.fps > video.screenRefreshRate) {
    throw invalidConfiguration(`${path}: fps must not exceed screenRefreshRate`);
  }
  return video;
}

function configuredScreenRefreshRate(
  env: AgentbrowseEnvironment,
  object: JsonObject,
  path: string,
  fallback: number,
): number {
  const value = configuredInteger(
    env,
    "AGENTBROWSE_BROWSER_VIDEO_SCREEN_REFRESH_RATE",
    object,
    "screenRefreshRate",
    fallback,
    10,
    60,
    path,
  );
  if (value !== 10 && value !== 25 && value !== 30 && value !== 60) {
    throw invalidConfiguration(
      `AGENTBROWSE_BROWSER_VIDEO_SCREEN_REFRESH_RATE or ${path}: screenRefreshRate must be 10, 25, 30, or 60`,
    );
  }
  return value;
}

function parseBackends(
  value: unknown,
  path: string,
  env: AgentbrowseEnvironment,
  sharedVideo: BrowserVideoConfig,
): readonly BackendConfig[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidConfiguration(`${path}: backends must be a non-empty array`);
  }
  const ids = new Set<string>();
  return value.map((entry, index) => {
    if (!isObject(entry)) {
      throw invalidConfiguration(`${path}: backends[${index}] must be a JSON object`);
    }
    const id = requiredString(entry, "id", `${path}: backends[${index}]`);
    if (!BACKEND_ID_PATTERN.test(id)) {
      throw invalidConfiguration(`${path}: backend id must match [a-z][a-z0-9-]{0,31}: ${id}`);
    }
    if (ids.has(id)) throw invalidConfiguration(`${path}: duplicate backend id: ${id}`);
    ids.add(id);

    const location = `${path}: backends[${index}]`;
    const video =
      entry.video === undefined
        ? undefined
        : configuredBrowserVideo(
            env,
            objectValue(entry, "video", location),
            `${location}.video`,
            sharedVideo,
          );

    if (entry.type === "docker") return parseDockerBackend(entry, id, path, index, video);
    if (entry.type === "apple-container") return parseAppleBackend(entry, id, path, index, video);
    throw invalidConfiguration(`${path}: backends[${index}].type is unsupported`);
  });
}

function parseDockerBackend(
  entry: JsonObject,
  id: string,
  path: string,
  index: number,
  video: BrowserVideoConfig | undefined,
): DockerBackendConfig {
  const location = `${path}: backends[${index}]`;
  const networkAddress = optionalString(entry, "networkAddress", location);
  const networkAddressCommand = optionalString(entry, "networkAddressCommand", location);
  if ((networkAddress === null) === (networkAddressCommand === null)) {
    throw invalidConfiguration(
      `${location} must set exactly one of networkAddress and networkAddressCommand`,
    );
  }
  return {
    id,
    type: "docker",
    context: requiredString(entry, "context", location),
    expectedEndpoint: optionalString(entry, "expectedEndpoint", location),
    expectedEngine: optionalString(entry, "expectedEngine", location),
    remoteHost: requiredString(entry, "remoteHost", location),
    networkAddress,
    networkAddressCommand,
    ...(video === undefined ? {} : { video }),
  };
}

function parseAppleBackend(
  entry: JsonObject,
  id: string,
  path: string,
  index: number,
  video: BrowserVideoConfig | undefined,
): AppleContainerBackendConfig {
  const location = `${path}: backends[${index}]`;
  const command = optionalString(entry, "command", location) ?? "/usr/local/bin/container";
  const applicationRoot =
    optionalString(entry, "applicationRoot", location) ??
    join(homedir(), "Library", "Application Support", "agentbrowse-infra", "runtime");
  if (!isAbsolute(command)) throw invalidConfiguration(`${location}.command must be absolute`);
  if (!isAbsolute(applicationRoot)) {
    throw invalidConfiguration(`${location}.applicationRoot must be absolute`);
  }
  const maxTargets = optionalInteger(entry, "maxTargets", 1, location);
  const cpus = optionalInteger(entry, "cpus", 2, location);
  const memory = optionalString(entry, "memory", location) ?? "6G";
  if (maxTargets !== 1) throw invalidConfiguration(`${location}.maxTargets must be 1`);
  if (cpus !== 2) throw invalidConfiguration(`${location}.cpus must be 2`);
  if (memory !== "6G") throw invalidConfiguration(`${location}.memory must be 6G`);
  return {
    id,
    type: "apple-container",
    command,
    applicationRoot,
    maxTargets: 1,
    cpus: 2,
    memory,
    ...(video === undefined ? {} : { video }),
  };
}

function readConfigFile(path: string): JsonObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw invalidConfiguration(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isObject(parsed)) throw invalidConfiguration(`${path} must contain a JSON object`);
  return parsed;
}

function objectValue(root: JsonObject, key: string, path: string): JsonObject {
  const value = root[key];
  if (value === undefined) return {};
  if (!isObject(value)) throw invalidConfiguration(`${path}: ${key} must be a JSON object`);
  return value;
}

function configuredString(
  env: AgentbrowseEnvironment,
  envName: string,
  object: JsonObject,
  key: string,
  path: string,
): string | null {
  const value = env[envName] ?? object[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || hasControlCharacter(value)) {
    throw invalidConfiguration(`${envName} or ${path}: ${key} must be a non-empty string`);
  }
  return value;
}

function requiredString(object: JsonObject, key: string, location: string): string {
  const value = optionalString(object, key, location);
  if (value === null) throw invalidConfiguration(`${location}.${key} is required`);
  return value;
}

function optionalString(object: JsonObject, key: string, location: string): string | null {
  const value = object[key];
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "" || hasControlCharacter(value)) {
    throw invalidConfiguration(`${location}.${key} must be a non-empty string`);
  }
  return value;
}

function optionalInteger(
  object: JsonObject,
  key: string,
  fallback: number,
  location: string,
): number {
  const value = object[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) {
    throw invalidConfiguration(`${location}.${key} must be an integer`);
  }
  return Number(value);
}

function configuredBoolean(
  env: AgentbrowseEnvironment,
  envName: string,
  object: JsonObject,
  key: string,
  fallback: boolean,
  path: string,
): boolean {
  const environmentValue = env[envName];
  if (environmentValue !== undefined) {
    if (environmentValue === "true") return true;
    if (environmentValue === "false") return false;
    throw invalidConfiguration(`${envName} must be true or false`);
  }
  const value = object[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    throw invalidConfiguration(`${path}: ${key} must be true or false`);
  }
  return value;
}

function configuredInteger(
  env: AgentbrowseEnvironment,
  envName: string,
  object: JsonObject,
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
  path: string,
): number {
  const environmentValue = env[envName];
  const value = environmentValue === undefined ? object[key] : Number(environmentValue);
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw invalidConfiguration(
      `${envName} or ${path}: ${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return Number(value);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f;
  });
}

function invalidConfiguration(message: string): CliError {
  return new CliError("invalid_configuration", message);
}
