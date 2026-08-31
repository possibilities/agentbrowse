/**
 * The MCP server `agentbrowse mcp` serves, constructed but not connected.
 *
 * Two things make this a generated surface rather than a second one. The
 * tools come from `CONTRACT` through `mcp-tools.ts`, so adding an
 * `audience: agent` leaf to `contract.ts` adds a tool with no edit here. And
 * every call dispatches through the exact functions `main.ts`'s own `run()`
 * already calls — `BrowserFleet`'s methods, `resolveWithTimeout`, `runView` —
 * in this same process, with nothing spawned and no argv built or re-parsed.
 *
 * AgentBoard's sibling module reaches a shared `COMMAND_TABLE` through one
 * `runPrepared(invocation, env, home)` call, because its CLI already routes
 * every command through that registry. agentbrowse's CLI has no such
 * registry — `main.ts`'s `run()` is its own if/else chain over a parsed
 * `Parsed` union — so there is no shared dispatcher to reach here. `dispatch`
 * below is the same kind of routing, once, in a switch over each tool's own
 * full path, calling the identical handler functions `run()` calls rather
 * than reconstructing a `Parsed` value and re-entering `run()`.
 *
 * One consequence: `UsageError` cannot arise here the way it can in
 * AgentBoard's `invocationFor`. There, positionals are built from typed tool
 * arguments and can still be malformed before a command ever sees them; here,
 * the MCP SDK validates every call against the generated Zod schema before
 * `callTool` runs, so a bad call never reaches `dispatch` at all.
 *
 * `mcp.ts` is the entrypoint that connects a transport to what this returns.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { CONTRACT } from "./contract.ts";
import { failure, success } from "./envelope.ts";
import { CliError } from "./errors.ts";
import {
  createPayload,
  listPayload,
  profileListPayload,
  resolvePayload,
  resolveWithTimeout,
} from "./main.ts";
import { type AgentTool, agentTools, serverInstructions } from "./mcp-tools.ts";
import { browserFarm } from "./runtime.ts";
import { runView } from "./view.ts";

export interface ServerOptions {
  env: Readonly<Record<string, string | undefined>>;
}

export function createAgentbrowseMcpServer(options: ServerOptions): McpServer {
  const server = new McpServer(
    { name: CONTRACT.meta.name, version: CONTRACT.meta.version },
    { instructions: serverInstructions(CONTRACT) },
  );
  for (const tool of agentTools(CONTRACT)) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      // The SDK infers the callback's argument type from the input schema, which
      // is built at runtime and so infers to nothing useful. The shape is
      // whatever the schema just validated: a plain object of argument values.
      (args: unknown) => callTool(tool, (args ?? {}) as Record<string, unknown>, options),
    );
  }
  return server;
}

/**
 * One tool call, dispatched in process.
 *
 * The farm is built fresh for the call, exactly as `run()` builds it fresh
 * for a terminal invocation: it is a config-derived description of the
 * configured backends, not a held connection, so there is nothing a resident
 * server would gain by keeping one alive across calls.
 */
async function callTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  options: ServerOptions,
): Promise<CallToolResult> {
  try {
    const data = await dispatch(tool, args, options.env);
    return { content: [{ type: "text", text: JSON.stringify(success(data), null, 2) }] };
  } catch (error) {
    return toolError(error);
  }
}

async function dispatch(
  tool: AgentTool,
  args: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>>,
): Promise<unknown> {
  const farm = browserFarm(env);
  switch (tool.name) {
    case "create": {
      const name = args["name"] as string;
      const slot = args["slot"] as number;
      const profile = args["profile"] as string | undefined;
      const image = args["image"] as string | undefined;
      const result = await farm.create({
        name,
        slot,
        ...(profile === undefined ? {} : { profile }),
        ...(image === undefined ? {} : { image }),
      });
      return createPayload(result);
    }
    case "list":
      return listPayload(await farm.list());
    case "destroy":
      return await farm.destroy(args["name"] as string);
    case "profile_create":
      return await farm.createProfile(args["name"] as string);
    case "profile_list":
      return profileListPayload(await farm.listProfiles());
    case "profile_delete":
      return await farm.deleteProfile(args["name"] as string);
    case "resolve": {
      const session = (args["session"] as string | undefined) ?? "default";
      return resolvePayload(await resolveWithTimeout(session, farm));
    }
    case "view": {
      // Resolved once here for the payload's own sake — `runView` resolves
      // again internally before it launches, exactly as running `agentbrowse
      // resolve` and then `agentbrowse view` at a terminal would.
      const session = (args["session"] as string | undefined) ?? "default";
      const resolved = await resolveWithTimeout(session, farm);
      const exitCode = await runView(session, env, undefined, farm);
      if (exitCode !== 0) {
        throw new CliError(
          "command_failed",
          `Live View for ${resolved.target.name} exited with status ${exitCode}`,
        );
      }
      return { session, profile: resolved.profile, target: resolved.target.name };
    }
    case "guide":
      return CONTRACT;
    default:
      // Unreachable while `mcp-tools.ts` only ever names a leaf this switch
      // covers; kept as a refusal rather than a silent `undefined` result if
      // a new agent leaf is ever added to the contract without a branch here.
      throw new CliError("unexpected_error", `agentbrowse mcp has no dispatch for ${tool.name}`);
  }
}

/**
 * A refusal, as MCP.md rules: the message leads with `error.code`, then the
 * message, then `recovery` when the contract gives one — the recovery line is
 * the difference between a caller that retries correctly and one that retries
 * identically. The envelope follows, so anything already parsing agentbrowse
 * parses the same shape here.
 */
function toolError(error: unknown): CallToolResult {
  const domain =
    error instanceof CliError
      ? error
      : new CliError("unexpected_error", error instanceof Error ? error.message : String(error));
  const lines = [`${domain.code}: ${domain.message}`];
  if (domain.recovery !== undefined) lines.push(`recovery: ${domain.recovery}`);
  lines.push(JSON.stringify(failure(domain), null, 2));
  return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
}
