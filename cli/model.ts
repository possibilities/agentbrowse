import { createHash } from "node:crypto";
import { join } from "node:path";

import { CliError, UsageError } from "./errors.ts";

export const SCHEMA_VERSION = 1;
export const TARGET_RECEIPT_VERSION = 2;
export const HTTP_BASE_PORT = 18080;
export const WEBRTC_BASE_PORT = 56000;
export const CDP_BASE_PORT = 9222;
export const CHROMIUM_FLAGS = "--start-fullscreen --disable-infobars";
export const PROFILE_SCHEMA_VERSION = 1;
export const PROFILE_MOUNT_PATH = "/home/kernel/user-data";

export interface BrowserProfile {
  readonly name: string;
  readonly volume: string;
}

export type LiveViewAccess =
  | { readonly mode: "ssh"; readonly remoteHost: string; readonly remotePort: number }
  | { readonly mode: "direct"; readonly baseUrl: string };

export interface BrowserAccess {
  readonly cdpUrl: string;
  readonly liveViewUrl: string;
  readonly liveViewAccess: LiveViewAccess;
}

export interface Target {
  readonly name: string;
  readonly profile: string;
  readonly slot: number;
  readonly backend: string;
  readonly container: string;
  readonly httpPort: number;
  readonly webrtcPort: number;
  readonly cdpPort: number;
}

export interface BrowserDescription extends Target, BrowserAccess {
  readonly image: string;
}

export interface TargetIdentity {
  readonly profile?: string;
  readonly backend?: string;
  readonly container?: string;
}

export function profileFor(name: string): BrowserProfile {
  validateName(name);
  return { name, volume: `agentbrowse-profile-${name}` };
}

export function targetFor(name: string, slot: number, identity: TargetIdentity = {}): Target {
  validateName(name);
  const profile = identity.profile ?? name;
  const backend = identity.backend ?? "docker";
  const container = identity.container ?? `agentbrowse-browser-${name}`;
  validateName(profile);
  validateSlot(slot);
  validateBackendId(backend);
  validateContainerName(container);
  return {
    name,
    profile,
    slot,
    backend,
    container,
    httpPort: HTTP_BASE_PORT + slot,
    webrtcPort: WEBRTC_BASE_PORT + slot,
    cdpPort: CDP_BASE_PORT + slot,
  };
}

export function validateName(name: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new UsageError(`name must match [a-z][a-z0-9-]{0,31}: ${name}`);
  }
}

export function validateBackendId(id: string): void {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(id)) {
    throw new CliError("invalid_target_receipt", `invalid backend id in target receipt: ${id}`);
  }
}

function validateContainerName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/.test(name)) {
    throw new CliError(
      "invalid_target_receipt",
      `invalid container name in target receipt: ${name}`,
    );
  }
}

export function providerProfileName(session: string): string {
  if (/^[a-z][a-z0-9-]{0,31}$/.test(session)) return session;

  let stem = session
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (stem === "") stem = "session";
  if (!/^[a-z]/.test(stem)) stem = `s-${stem}`;
  stem = stem.slice(0, 23).replace(/-+$/g, "");
  const digest = createHash("sha256").update(session).digest("hex").slice(0, 8);
  return `${stem}-${digest}`;
}

export function incarnatedTargetName(profile: string, token: string): string {
  validateName(profile);
  if (!/^[a-f0-9]{16}$/.test(token)) {
    throw new UsageError(`incarnation token must be 16 lowercase hex characters: ${token}`);
  }
  const stem = profile.slice(0, 15).replace(/-+$/g, "");
  return `${stem}-${token}`;
}

export function validateSlot(slot: number): void {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot > 999) {
    throw new UsageError(`slot must be an integer from 0 to 999: ${slot}`);
  }
  if (WEBRTC_BASE_PORT + slot > 65535) {
    throw new UsageError(`slot is out of port range: ${slot}`);
  }
}

export function parseSlot(value: string): number {
  if (!/^(0|[1-9][0-9]{0,2})$/.test(value)) {
    throw new UsageError(`slot must be an integer from 0 to 999: ${value}`);
  }
  const slot = Number(value);
  validateSlot(slot);
  return slot;
}

export function configPath(runtimeDir: string, name: string): string {
  validateName(name);
  return join(runtimeDir, `${name}.json`);
}

export function parseTargetConfig(source: string): Target {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new CliError("invalid_target_receipt", "target receipt is not valid JSON");
  }
  if (!isObject(value) || value.version !== TARGET_RECEIPT_VERSION) {
    throw new CliError("invalid_target_receipt", "target receipt version is unsupported");
  }
  const backend = requiredString(value, "backend");
  const container = requiredString(value, "container");
  const name = requiredString(value, "target");
  const profile = requiredString(value, "profile");
  const slot = value.slot;
  if (!Number.isSafeInteger(slot) || Number(slot) < 0 || Number(slot) > 999) {
    throw new CliError("invalid_target_receipt", "target receipt slot is invalid");
  }
  return targetFor(name, Number(slot), { backend, container, profile });
}

export function renderTargetConfig(target: Target): string {
  return `${JSON.stringify(
    {
      version: TARGET_RECEIPT_VERSION,
      backend: target.backend,
      container: target.container,
      target: target.name,
      profile: target.profile,
      slot: target.slot,
    },
    null,
    2,
  )}\n`;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") {
    throw new CliError("invalid_target_receipt", `target receipt ${key} is invalid`);
  }
  return field;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
