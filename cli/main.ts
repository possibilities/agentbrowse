#!/usr/bin/env bun

import { tmpdir } from "node:os";
import { join } from "node:path";

import { DockerFarmBackend } from "./backend.ts";
import { CliError, UsageError } from "./errors.ts";
import { BrowserFarm, type CreateResult, type DestroyResult } from "./farm.ts";
import { parseSlot, SCHEMA_VERSION } from "./model.ts";

const HELP = `agentbrowse: create Kernel browsers on Artbird

Usage:
  agentbrowse create NAME --slot N [--image REF] [--json]
  agentbrowse destroy NAME [--json]

Commands:
  create   Create or start one CDP + Live View browser target
  destroy  Delete one exactly owned browser target and its runtime metadata

Options:
  --slot N     Port slot from 0 to 999; required by create
  --image REF  Kernel image already loaded on Artbird
  --json       Emit the stable machine envelope
  -h, --help   Show this help
`;

interface ParsedCreate {
  command: "create";
  name: string;
  slot: number;
  image?: string;
  json: boolean;
}

interface ParsedDestroy {
  command: "destroy";
  name: string;
  json: boolean;
}

type Parsed = ParsedCreate | ParsedDestroy | { command: "help"; json: boolean };

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv: readonly string[]): Parsed {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    return { command: "help", json };
  }
  const command = args[0];
  const name = args[1];
  if (command !== "create" && command !== "destroy") {
    throw new UsageError(`unknown command: ${command}`);
  }
  if (name === undefined || name.startsWith("--")) {
    throw new UsageError(`${command} requires a browser target name`);
  }

  if (command === "destroy") {
    if (args.length !== 2) throw new UsageError(`unexpected argument: ${args[2]}`);
    return { command, name, json };
  }

  let slot: number | undefined;
  let image: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--slot") {
      slot = parseSlot(takeValue(args, index, arg));
      index += 1;
    } else if (arg === "--image") {
      image = takeValue(args, index, arg);
      index += 1;
    } else if (arg === "-h" || arg === "--help") {
      return { command: "help", json };
    } else {
      throw new UsageError(`unknown option for create: ${arg}`);
    }
  }
  if (slot === undefined) throw new UsageError("create requires --slot N");
  return { command, name, slot, ...(image === undefined ? {} : { image }), json };
}

function runtimeDir(env: Readonly<Record<string, string | undefined>>): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return env.AGENTBROWSE_RUNTIME_DIR ?? join(tmpdir(), `agentbrowse-live-view-${uid}`);
}

function success(data: unknown): string {
  return `${JSON.stringify({ schema_version: SCHEMA_VERSION, ok: true, error: null, data })}\n`;
}

function createPayload(result: CreateResult): Record<string, unknown> {
  return {
    name: result.name,
    slot: result.slot,
    container: result.container,
    image: result.image,
    ports: {
      cdp: result.cdpPort,
      live_view_http: result.httpPort,
      live_view_webrtc: result.webrtcPort,
    },
    cdp_url: result.cdpUrl,
    live_view_url: result.liveViewUrl,
    created: result.created,
  };
}

function failure(error: CliError): string {
  return `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.recovery === undefined ? {} : { recovery: error.recovery }),
    },
    data: null,
  })}\n`;
}

function humanCreate(result: CreateResult): string {
  const verb = result.created ? "Created" : "Ready";
  return `${verb} browser target ${result.name}
  Container: ${result.container}
  Image: ${result.image}
  CDP: ${result.cdpUrl}
  Live View: ${result.liveViewUrl} (requires tools/live-view tunnel ${result.name})

Control:
  agent-browser --cdp ${result.cdpUrl} snapshot -i

View:
  tools/live-view tunnel ${result.name}
  tools/live-view launch ${result.name}
`;
}

function humanDestroy(result: DestroyResult): string {
  return result.destroyed
    ? `Deleted ${result.container}; its Kernel image was preserved\n`
    : `${result.container} was already absent; removed its runtime metadata\n`;
}

export async function run(argv: readonly string[], env = process.env): Promise<number> {
  const json = argv.includes("--json");
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`agentbrowse: ${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  if (parsed.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  const backend = new DockerFarmBackend(env);
  const farm = new BrowserFarm(backend, runtimeDir(env), env.AGENTBROWSE_NEKO_LOG_LEVEL ?? "info");
  try {
    if (parsed.command === "create") {
      const result = await farm.create({
        name: parsed.name,
        slot: parsed.slot,
        ...(parsed.image === undefined ? {} : { image: parsed.image }),
      });
      process.stdout.write(parsed.json ? success(createPayload(result)) : humanCreate(result));
    } else {
      const result = await farm.destroy(parsed.name);
      process.stdout.write(parsed.json ? success(result) : humanDestroy(result));
    }
    return 0;
  } catch (error) {
    const cliError =
      error instanceof CliError
        ? error
        : new CliError("unexpected_error", (error as Error).message || String(error));
    if (json) process.stdout.write(failure(cliError));
    else {
      process.stderr.write(`agentbrowse: ${cliError.message}\n`);
      if (cliError.recovery !== undefined) process.stderr.write(`Next: ${cliError.recovery}\n`);
    }
    return 1;
  }
}

if (import.meta.main) process.exit(await run(process.argv.slice(2)));
