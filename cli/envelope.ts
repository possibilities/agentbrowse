/**
 * The stable machine envelope, as a plain object rather than the printed
 * string `main.ts` writes to stdout. `mcp-server.ts` embeds this same shape
 * as a tool result's text, so it is factored out once here instead of being
 * reconstructed for the MCP surface.
 */

import type { CliError } from "./errors.ts";
import { SCHEMA_VERSION } from "./model.ts";

export interface Envelope<T> {
  schema_version: number;
  ok: boolean;
  error: { code: string; message: string; recovery?: string } | null;
  data: T | null;
}

export function success<T>(data: T): Envelope<T> {
  return { schema_version: SCHEMA_VERSION, ok: true, error: null, data };
}

export function failure(error: CliError): Envelope<never> {
  const body: NonNullable<Envelope<never>["error"]> = {
    code: error.code,
    message: error.message,
  };
  if (error.recovery !== undefined) body.recovery = error.recovery;
  return { schema_version: SCHEMA_VERSION, ok: false, error: body, data: null };
}
