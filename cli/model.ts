import { createHash } from "node:crypto";
import { join } from "node:path";

import { CliError, UsageError } from "./errors.ts";

export const SCHEMA_VERSION = 1;
export const HTTP_BASE_PORT = 18080;
export const WEBRTC_BASE_PORT = 56000;
export const CDP_BASE_PORT = 9222;
export const CHROMIUM_FLAGS = "--start-maximized --disable-infobars";

export interface Target {
  name: string;
  slot: number;
  container: string;
  httpPort: number;
  webrtcPort: number;
  cdpPort: number;
}

export interface BrowserDescription extends Target {
  image: string;
  cdpUrl: string;
  liveViewUrl: string;
}

export function targetFor(name: string, slot: number): Target {
  validateName(name);
  validateSlot(slot);
  return {
    name,
    slot,
    container: `agentbrowse-browser-${name}`,
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

export function providerTargetName(session: string): string {
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
  return join(runtimeDir, `${name}.env`);
}

export function parseTargetConfig(source: string): Target {
  const values = new Map<string, string>();
  for (const line of source.split("\n")) {
    if (line === "") continue;
    const match = /^([A-Z_]+)=([a-zA-Z0-9-]+)$/.exec(line);
    if (!match) throw new CliError("invalid_target_config", "target metadata is malformed");
    values.set(match[1]!, match[2]!);
  }

  const name = values.get("NAME");
  const slotValue = values.get("SLOT");
  if (name === undefined || slotValue === undefined) {
    throw new CliError("invalid_target_config", "target metadata is incomplete");
  }
  const expected = targetFor(name, parseSlot(slotValue));
  const recorded = {
    container: values.get("CONTAINER"),
    httpPort: values.get("HTTP_PORT"),
    webrtcPort: values.get("WEBRTC_PORT"),
    cdpPort: values.get("CDP_PORT"),
  };
  if (
    recorded.container !== expected.container ||
    recorded.httpPort !== String(expected.httpPort) ||
    recorded.webrtcPort !== String(expected.webrtcPort) ||
    recorded.cdpPort !== String(expected.cdpPort)
  ) {
    throw new CliError("invalid_target_config", "target metadata does not match its name and slot");
  }
  return expected;
}

export function renderTargetConfig(target: Target): string {
  return [
    `NAME=${target.name}`,
    `SLOT=${target.slot}`,
    `CONTAINER=${target.container}`,
    `HTTP_PORT=${target.httpPort}`,
    `WEBRTC_PORT=${target.webrtcPort}`,
    `CDP_PORT=${target.cdpPort}`,
    "",
  ].join("\n");
}
