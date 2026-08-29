import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { CliError } from "../cli/errors.ts";

export type AgentbrowseEnvironment = Readonly<Record<string, string | undefined>>;

export interface AgentbrowseConfig {
  readonly path: string;
  readonly docker: {
    readonly context: string | null;
    readonly expectedEndpoint: string | null;
    readonly expectedEngine: string | null;
  };
  readonly remote: {
    readonly host: string | null;
    readonly networkAddress: string | null;
    readonly networkAddressCommand: string | null;
  };
  readonly images: {
    readonly defaultImage: string | null;
  };
  readonly browser: {
    readonly nekoLogLevel: string;
    readonly timezone: string | null;
  };
  readonly provider: {
    readonly name: string;
    readonly description: string;
  };
  readonly liveView: {
    readonly labelPrefix: string;
    readonly username: string;
    readonly password: string;
    readonly readOnly: boolean;
  };
  readonly discovery: {
    readonly commandTimeoutMs: number;
  };
}

type JsonObject = Record<string, unknown>;

const DEFAULT_DISCOVERY_COMMAND_TIMEOUT_MS = 2_000;
const MIN_DISCOVERY_COMMAND_TIMEOUT_MS = 100;
const MAX_DISCOVERY_COMMAND_TIMEOUT_MS = 4_000;

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
  const docker = objectValue(root, "docker", path);
  const remote = objectValue(root, "remote", path);
  const images = objectValue(root, "images", path);
  const browser = objectValue(root, "browser", path);
  const provider = objectValue(root, "provider", path);
  const liveView = objectValue(root, "liveView", path);
  const discovery = objectValue(root, "discovery", path);

  const version = root.version;
  if (version !== undefined && version !== 1) {
    throw invalidConfiguration(`${path} has unsupported version ${String(version)}`);
  }
  const environmentNetworkAddress =
    env.AGENTBROWSE_NETWORK_ADDRESS === undefined
      ? null
      : configuredString(env, "AGENTBROWSE_NETWORK_ADDRESS", {}, "networkAddress", path);
  const environmentNetworkAddressCommand =
    env.AGENTBROWSE_NETWORK_ADDRESS_COMMAND === undefined
      ? null
      : configuredString(
          env,
          "AGENTBROWSE_NETWORK_ADDRESS_COMMAND",
          {},
          "networkAddressCommand",
          path,
        );
  if (environmentNetworkAddress !== null && environmentNetworkAddressCommand !== null) {
    throw invalidConfiguration(
      "AGENTBROWSE_NETWORK_ADDRESS and AGENTBROWSE_NETWORK_ADDRESS_COMMAND are mutually exclusive",
    );
  }
  const fileNetworkAddress = configuredString(
    {},
    "AGENTBROWSE_NETWORK_ADDRESS",
    remote,
    "networkAddress",
    path,
  );
  const fileNetworkAddressCommand = configuredString(
    {},
    "AGENTBROWSE_NETWORK_ADDRESS_COMMAND",
    remote,
    "networkAddressCommand",
    path,
  );
  if (
    environmentNetworkAddress === null &&
    environmentNetworkAddressCommand === null &&
    fileNetworkAddress !== null &&
    fileNetworkAddressCommand !== null
  ) {
    throw invalidConfiguration(
      `${path}: remote.networkAddress and remote.networkAddressCommand are mutually exclusive`,
    );
  }
  const networkAddress =
    environmentNetworkAddress ??
    (environmentNetworkAddressCommand === null ? fileNetworkAddress : null);
  const networkAddressCommand =
    environmentNetworkAddressCommand ??
    (environmentNetworkAddress === null ? fileNetworkAddressCommand : null);

  return {
    path,
    docker: {
      context: configuredString(env, "AGENTBROWSE_DOCKER_CONTEXT", docker, "context", path),
      expectedEndpoint: configuredString(
        env,
        "AGENTBROWSE_DOCKER_ENDPOINT",
        docker,
        "expectedEndpoint",
        path,
      ),
      expectedEngine: configuredString(
        env,
        "AGENTBROWSE_DOCKER_ENGINE",
        docker,
        "expectedEngine",
        path,
      ),
    },
    remote: {
      host: configuredString(env, "AGENTBROWSE_REMOTE_HOST", remote, "host", path),
      networkAddress,
      networkAddressCommand,
    },
    images: {
      defaultImage: configuredString(env, "AGENTBROWSE_IMAGE", images, "defaultImage", path),
    },
    browser: {
      nekoLogLevel:
        configuredString(env, "AGENTBROWSE_NEKO_LOG_LEVEL", browser, "nekoLogLevel", path) ??
        "info",
      timezone: configuredString(env, "AGENTBROWSE_BROWSER_TIMEZONE", browser, "timezone", path),
    },
    provider: {
      name:
        configuredString(env, "AGENTBROWSE_PROVIDER_NAME", provider, "name", path) ?? "agentbrowse",
      description:
        configuredString(env, "AGENTBROWSE_PROVIDER_DESCRIPTION", provider, "description", path) ??
        "Manage remote Kernel browser targets",
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

export function requireConfigured(
  value: string | null,
  field: string,
  envName: string,
  configPath: string,
): string {
  if (value !== null) return value;
  throw new CliError(
    "browser_host_not_configured",
    "Browser host is not configured",
    `set ${field} in ${configPath} or set ${envName}`,
  );
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
