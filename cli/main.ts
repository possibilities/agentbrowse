#!/usr/bin/env bun

import { type ParsedBackup, runBackup } from "./backup.ts";
import { CONTRACT, renderAgentHelp, renderHelp, renderTeaser } from "./contract.ts";
import { failure as failureEnvelope, success as successEnvelope } from "./envelope.ts";
import { CliError, UsageError } from "./errors.ts";
import type {
  BrowserListEntry,
  CreateResult,
  DestroyResult,
  ProfileCreateResult,
  ProfileDeleteResult,
  ProfileListEntry,
} from "./farm.ts";
import type { BrowserFleet } from "./fleet.ts";
import { parseSlot } from "./model.ts";
import { runProvider } from "./provider.ts";
import { type ResolvedProviderTarget, resolveProviderTarget } from "./resolve.ts";
import { browserFarm } from "./runtime.ts";
import { runView } from "./view.ts";

const TARGET_RESOLVE_TIMEOUT_MS = 15_000;

interface ParsedCreate {
  command: "create";
  name: string;
  profile?: string;
  slot: number;
  image?: string;
  json: boolean;
}

interface ParsedDestroy {
  command: "destroy";
  name: string;
  json: boolean;
  force?: boolean;
}

interface ParsedView {
  command: "view";
  session: string;
  json: false;
}

interface ParsedResolve {
  command: "resolve";
  session: string;
  json: boolean;
}

interface ParsedProfileCreate {
  command: "profile";
  action: "create";
  name: string;
  json: boolean;
}

interface ParsedProfileList {
  command: "profile";
  action: "list";
  json: boolean;
}

interface ParsedProfileDelete {
  command: "profile";
  action: "delete";
  name: string;
  json: boolean;
}

type Parsed =
  | {
      command: "session";
      action: "prepare" | "release";
      session: string;
      profile?: string;
      lease?: string;
      json: boolean;
    }
  | {
      command: "session";
      action: "stage";
      session: string;
      path: string;
      json: boolean;
    }
  | { command: "session"; action: "list"; json: boolean }
  | ParsedCreate
  | ParsedDestroy
  | ParsedProfileCreate
  | ParsedProfileList
  | ParsedProfileDelete
  | {
      command: "profile";
      action: "export" | "import";
      name: string;
      path: string;
      backend?: string;
      json: boolean;
    }
  | ParsedResolve
  | ParsedView
  | { command: "list"; json: boolean }
  | { command: "provider"; json: false }
  | { command: "mcp"; json: false }
  | { command: "guide"; json: boolean }
  | { command: "help"; json: boolean }
  | { command: "agent-help"; json: boolean }
  | { command: "agent-teaser"; json: boolean }
  | ParsedBackup;

function takeValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseBackup(args: readonly string[], json: boolean): ParsedBackup {
  const action = args[1];
  if (action === "measure") {
    const options = new Set(args.slice(2));
    for (const option of options) {
      if (option !== "--all" && option !== "--compression-estimate") {
        throw new UsageError(`unknown option for backup measure: ${option}`);
      }
    }
    if (!options.has("--all")) throw new UsageError("backup measure requires --all");
    return {
      command: "backup",
      action,
      all: true,
      compressionEstimate: options.has("--compression-estimate"),
      json,
    };
  }
  if (action !== "create" && action !== "list" && action !== "inspect" && action !== "restore") {
    throw new UsageError(
      action === undefined ? "backup requires an action" : `unknown backup action: ${action}`,
    );
  }
  let backend: string | undefined;
  let destination: string | undefined;
  let set: string | undefined;
  let identity: string | undefined;
  let expectedSetDigest: string | undefined;
  const recipients: string[] = [];
  let unencrypted = false;
  let allowUnencrypted = false;
  let releaseReservations = false;
  let dryRun = false;
  for (let index = 2; index < args.length; index += 1) {
    const option = args[index]!;
    if (option === "--backend") backend = takeValue(args, index++, option);
    else if (option === "--destination") destination = takeValue(args, index++, option);
    else if (option === "--set") set = takeValue(args, index++, option);
    else if (option === "--identity") identity = takeValue(args, index++, option);
    else if (option === "--expected-set-digest")
      expectedSetDigest = takeValue(args, index++, option);
    else if (option === "--recipient") recipients.push(takeValue(args, index++, option));
    else if (option === "--unencrypted") unencrypted = true;
    else if (option === "--allow-unencrypted") allowUnencrypted = true;
    else if (option === "--release-reservations") releaseReservations = true;
    else if (option === "--dry-run") dryRun = true;
    else throw new UsageError(`unknown option for backup ${action}: ${option}`);
  }
  if (backend === undefined) throw new UsageError(`backup ${action} requires --backend ID`);
  if (expectedSetDigest !== undefined && !/^[0-9a-f]{64}$/.test(expectedSetDigest))
    throw new UsageError("--expected-set-digest must be a lowercase SHA-256 digest");
  if (action === "create") {
    if (destination === undefined)
      throw new UsageError("backup create requires --destination ABSOLUTE_SET_PATH");
    if (
      set !== undefined ||
      identity !== undefined ||
      expectedSetDigest !== undefined ||
      allowUnencrypted ||
      releaseReservations
    )
      throw new UsageError("backup create does not accept --set or --identity");
    if (unencrypted && recipients.length > 0)
      throw new UsageError("backup create --unencrypted conflicts with --recipient");
    return {
      command: "backup",
      action,
      backend,
      destination,
      recipients,
      unencrypted,
      dryRun,
      json,
    };
  }
  if (recipients.length > 0 || unencrypted)
    throw new UsageError(`backup ${action} does not accept encryption creation options`);
  if (action === "list") {
    if (destination === undefined)
      throw new UsageError("backup list requires --destination ABSOLUTE_COLLECTION_PATH");
    if (set !== undefined || expectedSetDigest !== undefined || dryRun || releaseReservations)
      throw new UsageError(
        "backup list accepts only --backend, --destination, --identity, and --allow-unencrypted",
      );
    return {
      command: "backup",
      action,
      backend,
      destination,
      ...(identity === undefined ? {} : { identity }),
      allowUnencrypted,
      json,
    };
  }
  if (set === undefined) throw new UsageError(`backup ${action} requires --set ABSOLUTE_SET_PATH`);
  if (destination !== undefined)
    throw new UsageError(`backup ${action} does not accept --destination`);
  if (action === "inspect") {
    if (dryRun || releaseReservations)
      throw new UsageError("backup inspect does not accept --dry-run or --release-reservations");
    return {
      command: "backup",
      action,
      backend,
      set,
      ...(identity === undefined ? {} : { identity }),
      allowUnencrypted,
      ...(expectedSetDigest === undefined ? {} : { expectedSetDigest }),
      json,
    };
  }
  if (expectedSetDigest === undefined)
    throw new UsageError("backup restore requires --expected-set-digest SHA256");
  if (releaseReservations && dryRun)
    throw new UsageError("backup restore --release-reservations conflicts with --dry-run");
  return {
    command: "backup",
    action,
    backend,
    set,
    ...(identity === undefined ? {} : { identity }),
    allowUnencrypted,
    expectedSetDigest,
    releaseReservations,
    dryRun,
    json,
  };
}

export function parseArgs(argv: readonly string[]): Parsed {
  const json = argv.includes("--json");
  const args = argv.filter((arg) => arg !== "--json");
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help" || args[0] === "help") {
    return { command: "help", json };
  }
  if (args[0] === "--agent-help") {
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command: "agent-help", json };
  }
  if (args[0] === "--agent-teaser") {
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command: "agent-teaser", json };
  }
  const command = args[0];
  if (command === "guide") {
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json };
  }
  if (command === "provider") {
    if (json) throw new UsageError("provider does not accept --json");
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json: false };
  }
  if (command === "mcp") {
    if (json) throw new UsageError("mcp does not accept --json");
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json: false };
  }
  if (command === "backup") return parseBackup(args, json);
  if (command === "view") {
    if (json) throw new UsageError("view does not accept --json");
    if (args.length > 2) throw new UsageError(`unexpected argument: ${args[2]}`);
    const session = args[1];
    if (session?.startsWith("--")) throw new UsageError(`unexpected argument: ${session}`);
    return { command, session: session ?? "default", json: false };
  }
  if (command === "resolve") {
    if (args.length > 2) throw new UsageError(`unexpected argument: ${args[2]}`);
    const session = args[1];
    if (session?.startsWith("--")) throw new UsageError(`unexpected argument: ${session}`);
    return { command, session: session ?? "default", json };
  }
  if (command === "list") {
    if (args.length !== 1) throw new UsageError(`unexpected argument: ${args[1]}`);
    return { command, json };
  }
  if (command === "session") {
    const action = args[1];
    if (action === "list" && args.length === 2) return { command, action, json };
    const session = args[2];
    if (!session || session.startsWith("--"))
      throw new UsageError("session prepare/stage/release requires a session name");
    if (action === "prepare") {
      if (args.length === 3) return { command, action, session, json };
      if (args.length === 5 && args[3] === "--profile")
        return {
          command,
          action,
          session,
          profile: takeValue(args, 3, "--profile"),
          json,
        };
    }
    if (action === "release" && args.length === 5 && args[3] === "--lease")
      return {
        command,
        action,
        session,
        lease: takeValue(args, 3, "--lease"),
        json,
      };
    if (action === "stage") {
      const path = args[3];
      if (!path || path.startsWith("--"))
        throw new UsageError("session stage requires an absolute local file path");
      if (args.length === 4) return { command, action, session, path, json };
    }
    throw new UsageError(
      "use session prepare SESSION [--profile NAME], session list, session stage SESSION ABSOLUTE_PATH, or session release SESSION --lease LEASE",
    );
  }
  if (command === "profile") {
    if (args.includes("-h") || args.includes("--help")) return { command: "help", json };
    const action = args[1];
    if (action === "list") {
      if (args.length !== 2) throw new UsageError(`unexpected argument: ${args[2]}`);
      return { command, action, json };
    }
    if (action !== "create" && action !== "delete" && action !== "export" && action !== "import") {
      throw new UsageError(
        action === undefined ? "profile requires an action" : `unknown profile action: ${action}`,
      );
    }
    const profileName = args[2];
    if (profileName === undefined || profileName.startsWith("--")) {
      throw new UsageError(`profile ${action} requires a Browser profile name`);
    }
    if (action === "export" || action === "import") {
      const path = args[3];
      if (!path || path.startsWith("--"))
        throw new UsageError(`profile ${action} requires an archive path`);
      if (action === "import" && args.length === 6 && args[4] === "--backend") {
        return {
          command,
          action,
          name: profileName,
          path,
          backend: takeValue(args, 4, "--backend"),
          json,
        };
      }
      if (args.length !== 4) throw new UsageError(`unexpected argument: ${args[4]}`);
      return { command, action, name: profileName, path, json };
    }
    if (args.length !== 3) throw new UsageError(`unexpected argument: ${args[3]}`);
    return { command, action, name: profileName, json };
  }
  const name = args[1];
  if (command !== "create" && command !== "destroy") {
    throw new UsageError(`unknown command: ${command}`);
  }
  if (name === undefined || name.startsWith("--")) {
    throw new UsageError(`${command} requires a browser target name`);
  }

  if (command === "destroy") {
    if (args.length === 3 && args[2] === "--force") return { command, name, json, force: true };
    if (args.length !== 2) throw new UsageError(`unexpected argument: ${args[2]}`);
    return { command, name, json };
  }

  let slot: number | undefined;
  let profile: string | undefined;
  let image: string | undefined;
  for (let index = 2; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--slot") {
      slot = parseSlot(takeValue(args, index, arg));
      index += 1;
    } else if (arg === "--profile") {
      profile = takeValue(args, index, arg);
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
  return {
    command,
    name,
    ...(profile === undefined ? {} : { profile }),
    slot,
    ...(image === undefined ? {} : { image }),
    json,
  };
}

function success(data: unknown): string {
  return `${JSON.stringify(successEnvelope(data))}\n`;
}

export function createPayload(result: CreateResult): Record<string, unknown> {
  return {
    name: result.name,
    profile: result.profile,
    backend: result.backend,
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
  return `${JSON.stringify(failureEnvelope(error))}\n`;
}

function humanCreate(result: CreateResult): string {
  const verb = result.created ? "Created" : "Ready";
  return `${verb} browser target ${result.name}
  Browser profile: ${result.profile}
  Backend: ${result.backend}
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
    ? result.profile === null
      ? `Deleted ${result.container} from ${result.backend}; its Kernel image was preserved\n`
      : `Deleted ${result.container} from ${result.backend}; Browser profile ${result.profile} and its Kernel image were preserved\n`
    : `${result.container} was already absent from ${result.backend}; removed its runtime metadata\n`;
}

export function listPayload(results: readonly BrowserListEntry[]): Record<string, unknown> {
  return {
    browsers: results.map((browser) => ({
      name: browser.name,
      profile: browser.profile,
      backend: browser.backend,
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
    browser.profile ?? "-",
    browser.backend,
    String(browser.slot),
    browser.slotConflict ? `${browser.state} !` : browser.state,
    browser.cdpUrl,
    browser.liveViewUrl,
  ]);
  const headings = ["NAME", "PROFILE", "BACKEND", "SLOT", "STATE", "CDP", "LIVE VIEW"];
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

function humanProfileCreate(result: ProfileCreateResult): string {
  return `${result.created ? "Created" : "Ready"} Browser profile ${result.name} on ${result.backend} (${result.volume})\n`;
}

export function profileListPayload(results: readonly ProfileListEntry[]): Record<string, unknown> {
  return { profiles: results, count: results.length };
}

function humanProfileList(results: readonly ProfileListEntry[]): string {
  if (results.length === 0) return "No agentbrowse Browser profiles found\n";
  const rows = results.map((profile) => [
    profile.name,
    profile.backend,
    profile.volume,
    profile.consumers.length === 0 ? "-" : profile.consumers.join(","),
  ]);
  const headings = ["NAME", "BACKEND", "VOLUME", "CONSUMERS"];
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

function humanProfileDelete(result: ProfileDeleteResult): string {
  return result.deleted
    ? `Deleted Browser profile ${result.name} from ${result.backend} (${result.volume})\n`
    : `Browser profile ${result.name} was already absent from ${result.backend}\n`;
}

export function resolvePayload(result: ResolvedProviderTarget): Record<string, unknown> {
  return {
    session: result.session,
    profile: result.profile,
    target: {
      name: result.target.name,
      backend: result.target.backend,
      slot: result.target.slot,
      container: result.target.container,
      state: result.target.state,
      status: result.target.status,
    },
  };
}

function humanResolve(result: ResolvedProviderTarget): string {
  return `agent-browser session ${result.session}\n  Browser profile: ${result.profile}\n  Backend: ${result.target.backend}\n  Browser target: ${result.target.name}\n  Slot: ${result.target.slot}\n  State: ${result.target.state}\n`;
}

/**
 * `resolve`'s own fifteen-second bound, factored out so `mcp-server.ts` can
 * give a tool call the exact same timeout instead of resolving unbounded.
 */
export async function resolveWithTimeout(
  session: string,
  farm: Pick<BrowserFleet, "targetForProfile"> & Partial<Pick<BrowserFleet, "sessions">>,
): Promise<ResolvedProviderTarget> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(
      new CliError(
        "browser_target_resolve_timeout",
        `resolving agent-browser session ${session} exceeded ${TARGET_RESOLVE_TIMEOUT_MS / 1_000} seconds`,
        "check the configured browser host and retry",
      ),
    );
  }, TARGET_RESOLVE_TIMEOUT_MS);
  try {
    return await resolveProviderTarget(session, farm, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

export async function stageSessionUpload(
  session: string,
  path: string,
  farm: Pick<BrowserFleet, "targetForProfile" | "stageUpload"> &
    Partial<Pick<BrowserFleet, "sessions">>,
): Promise<Record<string, unknown>> {
  const resolved = await resolveWithTimeout(session, farm);
  const staged = await farm.stageUpload(resolved.target, path);
  return {
    session,
    profile: resolved.profile,
    target: { name: resolved.target.name, backend: resolved.target.backend },
    ...staged,
  };
}

export async function run(argv: readonly string[], env = process.env): Promise<number> {
  const json = argv.includes("--json");
  let parsed: Parsed;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`agentbrowse: ${(error as Error).message}\n\n${renderHelp()}`);
    return 2;
  }
  if (parsed.command === "help") {
    process.stdout.write(renderHelp());
    return 0;
  }
  if (parsed.command === "agent-teaser") {
    process.stdout.write(renderTeaser());
    return 0;
  }
  if (parsed.command === "agent-help") {
    process.stdout.write(renderAgentHelp());
    return 0;
  }
  if (parsed.command === "guide") {
    process.stdout.write(parsed.json ? success(CONTRACT) : renderAgentHelp());
    return 0;
  }
  if (parsed.command === "provider") return await runProvider(env);
  if (parsed.command === "mcp") {
    // Imported here, not at the top: the MCP server pulls in the protocol
    // SDK, and no other command should pay for loading it.
    const { serveAgentbrowseMcp } = await import("./mcp.ts");
    await serveAgentbrowseMcp({ env });
    return 0;
  }
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
    if (parsed.command === "backup") {
      const result = await runBackup(parsed, env);
      process.stdout.write(parsed.json ? success(result) : `${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    const farm = browserFarm(env);
    if (parsed.command === "session") {
      const result =
        parsed.action === "list"
          ? await farm.sessions.list()
          : parsed.action === "prepare"
            ? await farm.sessions.prepare(parsed.session, parsed.profile)
            : parsed.action === "stage"
              ? await stageSessionUpload(parsed.session, parsed.path, farm)
              : await farm.sessions.release(parsed.session, parsed.lease!);
      process.stdout.write(parsed.json ? success(result) : `${JSON.stringify(result, null, 2)}\n`);
    } else if (parsed.command === "create") {
      const result = await farm.create({
        name: parsed.name,
        ...(parsed.profile === undefined ? {} : { profile: parsed.profile }),
        slot: parsed.slot,
        ...(parsed.image === undefined ? {} : { image: parsed.image }),
      });
      process.stdout.write(parsed.json ? success(createPayload(result)) : humanCreate(result));
    } else if (parsed.command === "list") {
      const result = await farm.list();
      process.stdout.write(parsed.json ? success(listPayload(result)) : humanList(result));
    } else if (parsed.command === "resolve") {
      const result = await resolveWithTimeout(parsed.session, farm);
      process.stdout.write(parsed.json ? success(resolvePayload(result)) : humanResolve(result));
    } else if (parsed.command === "profile") {
      if (parsed.action === "create") {
        const result = await farm.createProfile(parsed.name);
        process.stdout.write(parsed.json ? success(result) : humanProfileCreate(result));
      } else if (parsed.action === "list") {
        const result = await farm.listProfiles();
        process.stdout.write(
          parsed.json ? success(profileListPayload(result)) : humanProfileList(result),
        );
      } else if (parsed.action === "export" || parsed.action === "import") {
        const result =
          parsed.action === "export"
            ? await farm.exportProfile(parsed.name, parsed.path)
            : await farm.importProfile(parsed.name, parsed.path, parsed.backend);
        process.stdout.write(
          parsed.json
            ? success(result)
            : `${parsed.action === "export" ? "Exported" : "Imported"} Browser profile ${result.name} on ${result.backend}: ${result.path}\n`,
        );
      } else {
        const result = await farm.deleteProfile(parsed.name);
        process.stdout.write(parsed.json ? success(result) : humanProfileDelete(result));
      }
    } else {
      const result = await farm.destroy(parsed.name, undefined, undefined, parsed.force);
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
