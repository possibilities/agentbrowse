#!/usr/bin/env bun

import { CliError, UsageError } from "./errors.ts";
import type { BrowserListEntry, CreateResult, DestroyResult } from "./farm.ts";
import { parseSlot, SCHEMA_VERSION } from "./model.ts";
import { runProvider } from "./provider.ts";
import { browserFarm } from "./runtime.ts";
import { runView } from "./view.ts";

const HELP = `agentbrowse: create remote Kernel browsers

Usage:
  agentbrowse create NAME --slot N [--image REF] [--json]
  agentbrowse list [--json]
  agentbrowse destroy NAME [--json]
  agentbrowse provider
  agentbrowse view [SESSION]

Commands:
  create   Create or start one CDP + Live View browser target
  list     List every browser target managed by agentbrowse
  destroy  Delete one exactly owned browser target and its runtime metadata
  provider Handle one agent-browser plugin protocol request over standard I/O
  view     Open a session's Browser target; uses the default session if omitted

Options:
  --slot N     Port slot from 0 to 999; required by create
  --image REF  Kernel image already loaded on the configured browser host
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

interface ParsedView {
  command: "view";
  session: string;
  json: false;
}

type Parsed =
  | ParsedCreate
  | ParsedDestroy
  | ParsedView
  | { command: "list"; json: boolean }
  | { command: "provider"; json: false }
  | { command: "help"; json: boolean };

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
  if (command === "provider") {
    if (json) throw new UsageError("provider does not accept --json");
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json: false };
  }
  if (command === "view") {
    if (json) throw new UsageError("view does not accept --json");
    if (args.length > 2) throw new UsageError(`unexpected argument: ${args[2]}`);
    const session = args[1];
    if (session?.startsWith("--")) throw new UsageError(`unexpected argument: ${session}`);
    return { command, session: session ?? "default", json: false };
  }
  if (command === "list") {
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json };
  }
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
  Live View: ${result.liveViewUrl} (opened by tools/live-view launch ${result.name})

Control:
  agent-browser --cdp ${result.cdpUrl} snapshot -i

View:
  tools/live-view launch ${result.name}
`;
}

function humanDestroy(result: DestroyResult): string {
  return result.destroyed
    ? `Deleted ${result.container}; its Kernel image was preserved\n`
    : `${result.container} was already absent; removed its runtime metadata\n`;
}

function listPayload(results: readonly BrowserListEntry[]): Record<string, unknown> {
  return {
    browsers: results.map((browser) => ({
      name: browser.name,
      slot: browser.slot,
      container: browser.container,
      state: browser.state,
      status: browser.status,
      cdp_url: browser.cdpUrl,
      live_view_url: browser.liveViewUrl,
      slot_conflict: browser.slotConflict,
    })),
    count: results.length,
  };
}

function humanList(results: readonly BrowserListEntry[]): string {
  if (results.length === 0) return "No agentbrowse browser targets found\n";
  const rows = results.map((browser) => [
    browser.name,
    String(browser.slot),
    browser.slotConflict ? `${browser.state} !` : browser.state,
    browser.cdpUrl,
    browser.liveViewUrl,
  ]);
  const headings = ["NAME", "SLOT", "STATE", "CDP", "LIVE VIEW"];
  const widths = headings.map((heading, index) =>
    Math.max(heading.length, ...rows.map((row) => row[index]!.length)),
  );
  const renderRow = (row: readonly string[]): string =>
    row
      .map((value, index) => value.padEnd(widths[index]!))
      .join("  ")
      .trimEnd();
  return `${renderRow(headings)}\n${rows.map(renderRow).join("\n")}\n`;
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
  if (parsed.command === "provider") return await runProvider(env);
  if (parsed.command === "view") {
    try {
      return await runView(parsed.session, env);
    } catch (error) {
      process.stderr.write(
        `agentbrowse: could not launch Live View: ${(error as Error).message || String(error)}\n`,
      );
      return 1;
    }
  }

  try {
    const farm = browserFarm(env);
    if (parsed.command === "create") {
      const result = await farm.create({
        name: parsed.name,
        slot: parsed.slot,
        ...(parsed.image === undefined ? {} : { image: parsed.image }),
      });
      process.stdout.write(parsed.json ? success(createPayload(result)) : humanCreate(result));
    } else if (parsed.command === "list") {
      const result = await farm.list();
      process.stdout.write(parsed.json ? success(listPayload(result)) : humanList(result));
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
