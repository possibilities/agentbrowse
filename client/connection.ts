import type { BrowserListEntry } from "../cli/farm.ts";

export const LIVE_VIEW_DESCRIPTOR_VERSION = 1;

export interface LiveViewConnectionDescriptor {
  version: 1;
  label: string;
  base_url: string;
  username: string;
  password: string;
  read_only: boolean;
}

export interface ConnectionDescriptorOptions {
  labelPrefix?: string;
  username?: string;
  password?: string;
  readOnly?: boolean;
}

export function connectionDescriptor(
  target: Pick<BrowserListEntry, "name">,
  baseUrl: string,
  options: ConnectionDescriptorOptions = {},
): LiveViewConnectionDescriptor {
  return {
    version: LIVE_VIEW_DESCRIPTOR_VERSION,
    label: `${options.labelPrefix ?? "agentbrowse"}/${target.name}`,
    base_url: baseUrl,
    username: options.username ?? "kernel",
    password: options.password ?? "admin",
    read_only: options.readOnly ?? false,
  };
}

/** The returned bytes may contain credentials and must never be logged. */
export function encodeConnectionDescriptor(descriptor: LiveViewConnectionDescriptor): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(descriptor));
}
