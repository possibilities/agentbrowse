/**
 * The generated MCP surface.
 *
 * Two halves, and both matter. The mapping is checked in process against
 * `mcp-tools.ts` — what becomes a tool, what is suppressed, and how each
 * constraint lands in the schema. Then a real `agentbrowse mcp` is spawned
 * and driven over stdio by a real MCP client: initialize, tools/list,
 * tools/call. A mapping that is only unit-tested is a mapping that has never
 * once been spoken to.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as z4mini from "zod/v4-mini";
import { CONTRACT, type ContractCommand } from "../cli/contract.ts";
import { ANNOTATION_EXCEPTIONS, agentTools, serverInstructions } from "../cli/mcp-tools.ts";

const MAIN = new URL("../cli/main.ts", import.meta.url).pathname;

const TOOLS = agentTools(CONTRACT);

function leaves(
  commands: readonly ContractCommand[],
  prefix: string[] = [],
): { path: string; leaf: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    return command.subcommands === undefined
      ? [{ path: path.join(" "), leaf: command }]
      : leaves(command.subcommands, path);
  });
}

const LEAVES = leaves(CONTRACT.commands);

/** The advertised JSON Schema, as a host sees it after the SDK converts. */
function schemaOf(name: string): Record<string, unknown> {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return z4mini.toJSONSchema(tool.input, { target: "draft-2020-12", io: "input" }) as Record<
    string,
    unknown
  >;
}

describe("which commands become tools", () => {
  test("exactly the agent leaves, and every one of them", () => {
    const wanted = LEAVES.filter(({ leaf }) => leaf.audience === "agent").map(({ path }) =>
      path.replace(/ /g, "_"),
    );
    expect(TOOLS.map((tool) => tool.name).sort()).toEqual([...wanted].sort());
    expect(wanted.length).toBe(9);
  });

  test("no operator or internal leaf is exposed, mcp and provider included", () => {
    const exposed = new Set(TOOLS.map((tool) => tool.name));
    const hidden = LEAVES.filter(({ leaf }) => leaf.audience !== "agent");
    expect(hidden.map(({ path }) => path).sort()).toEqual(["mcp", "provider"]);
    for (const { path } of hidden) expect(exposed.has(path.replace(/ /g, "_"))).toBe(false);
  });

  test("mcp declares itself internal, mutating, and blocking", () => {
    const mcp = CONTRACT.commands.find((command) => command.name === "mcp");
    expect(mcp).toBeDefined();
    expect(mcp?.audience).toBe("internal");
    expect(mcp?.mutates).toBe(true);
    expect(mcp?.blocking).toBe(true);
  });

  test("provider is internal, the canonical suppression case", () => {
    const provider = CONTRACT.commands.find((command) => command.name === "provider");
    expect(provider?.audience).toBe("internal");
    expect(TOOLS.map((tool) => tool.name)).not.toContain("provider");
  });

  test("a nested leaf is named by its full path, joined with an underscore", () => {
    expect(TOOLS.map((tool) => tool.name)).toContain("profile_create");
    expect(TOOLS.map((tool) => tool.name)).toContain("profile_list");
    expect(TOOLS.map((tool) => tool.name)).toContain("profile_delete");
    // Never prefixed with the CLI name: the host namespaces by server.
    expect(TOOLS.every((tool) => !tool.name.startsWith("agentbrowse"))).toBe(true);
  });
});

describe("the input schema", () => {
  test("every global is suppressed, because neither is a call knob", () => {
    for (const global of CONTRACT.global_arguments) {
      expect(global.role ?? "call").not.toBe("call");
    }
    const property = (name: string) => name.replace(/^--/, "");
    for (const tool of TOOLS) {
      const properties = Object.keys(schemaOf(tool.name)["properties"] ?? {});
      for (const global of CONTRACT.global_arguments) {
        expect(properties).not.toContain(property(global.name));
      }
    }
  });

  test("--slot's bound becomes a schema minimum and maximum", () => {
    const schema = schemaOf("create") as {
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
    expect(schema.properties["slot"]?.["type"]).toBe("integer");
    expect(schema.properties["slot"]?.["minimum"]).toBe(0);
    expect(schema.properties["slot"]?.["maximum"]).toBe(999);
    expect(schema.required).toContain("slot");
  });

  test("a positional argument is an ordinary property", () => {
    const schema = schemaOf("destroy") as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties).toHaveProperty("name");
    expect(schema.required).toContain("name");
  });

  test("a defaulted positional is optional with its default carried", () => {
    const schema = schemaOf("resolve") as { properties: Record<string, Record<string, unknown>> };
    expect(schema.properties["session"]?.["default"]).toBe("default");
  });
});

describe("annotations", () => {
  const annotationsOf = (name: string) =>
    TOOLS.find((tool) => tool.name === name)?.annotations ?? {};

  test("readOnlyHint is the contract's own mutates judgment", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.readOnlyHint).toBe(tool.leaf.mutates === false);
    }
    expect(annotationsOf("list")).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    expect(annotationsOf("resolve")).toMatchObject({ readOnlyHint: true });
  });

  test("a removing verb is destructive, and create is not", () => {
    expect(annotationsOf("destroy")).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(annotationsOf("profile_delete")).toMatchObject({ destructiveHint: true });
    expect(annotationsOf("create")).toMatchObject({ destructiveHint: false, idempotentHint: true });
  });

  test("every leaf reaches a configured backend except guide", () => {
    for (const tool of TOOLS) {
      expect(tool.annotations.openWorldHint).toBe(tool.name !== "guide");
    }
  });

  test("the mapping's exception lists name commands that exist", () => {
    const paths = new Set(TOOLS.map((tool) => tool.path.join(" ")));
    for (const path of ANNOTATION_EXCEPTIONS.appending) expect(paths.has(path)).toBe(true);
    for (const path of ANNOTATION_EXCEPTIONS.network) expect(paths.has(path)).toBe(true);
  });
});

describe("the server's instructions", () => {
  const instructions = serverInstructions(CONTRACT);

  test("carry the guidance, the envelope, every error code, and the opening moves", () => {
    expect(instructions).toContain("Three lifetimes are deliberately distinct");
    expect(instructions).toContain("schema_version");
    for (const entry of CONTRACT.concepts.error_codes) {
      expect(instructions).toContain(entry.code);
      if (entry.recovery !== undefined) expect(instructions).toContain(entry.recovery);
    }
    for (const line of CONTRACT.concepts.agent_defaults) expect(instructions).toContain(line);
  });

  test("state agentbrowse's own boundary: target lifecycle, resolution, and handoff only", () => {
    expect(instructions).toContain("does not touch pages");
    expect(instructions).toContain("agent-browser");
  });
});

/**
 * The round trip. A real server process, a real client, a real handshake — the
 * one thing that cannot be faked by agreeing with the mapping module.
 */
describe("a live stdio server", () => {
  let directory: string;
  let client: Client;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "agentbrowse-mcp-"));
    client = new Client({ name: "agentbrowse-test", version: "0" });
    await client.connect(
      new StdioClientTransport({
        command: "bun",
        args: [MAIN, "mcp"],
        env: {
          ...(process.env as Record<string, string>),
          AGENTBROWSE_CONFIG: join(directory, "config.json"),
          AGENTBROWSE_RUNTIME_DIR: join(directory, "runtime"),
          AGENTBROWSE_STATE_DIR: join(directory, "state"),
        },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test("initialize names the CLI and hands back the contract's instructions", () => {
    expect(client.getServerVersion()?.name).toBe("agentbrowse");
    expect(client.getInstructions() ?? "").toContain("Three lifetimes are deliberately distinct");
  });

  test("tools/list is exactly the agent leaves the mapping generated", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOLS.map((tool) => tool.name).sort());
    expect(tools.map((tool) => tool.name)).toContain("profile_create");
    expect(tools.map((tool) => tool.name)).not.toContain("mcp");
    expect(tools.map((tool) => tool.name)).not.toContain("provider");
  });

  test("a read-only tool returns the CLI's own envelope", async () => {
    // No backend is configured in this sandbox, so the farm is empty and
    // `list` reports it that way rather than failing — the same thing
    // `agentbrowse list --json` would print against this same config.
    const result = (await client.callTool({ name: "list", arguments: {} })) as {
      isError?: boolean;
      content: { type: string; text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    const envelope = JSON.parse(result.content[0]!.text);
    expect(envelope).toMatchObject({ schema_version: 1, ok: true, error: null });
    expect(envelope.data).toMatchObject({ browsers: [], count: 0 });
  });

  test("guide returns the same contract this test loaded", async () => {
    const result = (await client.callTool({ name: "guide", arguments: {} })) as {
      isError?: boolean;
      content: { text: string }[];
    };
    expect(result.isError ?? false).toBe(false);
    expect(JSON.parse(result.content[0]!.text).data).toEqual(JSON.parse(JSON.stringify(CONTRACT)));
  });

  test("a mutating tool dispatches through the same farm and its own error code", async () => {
    // No backend is configured, so `destroy` cannot succeed — but it must
    // fail as agentbrowse's own domain error, not as a transport fault.
    const result = (await client.callTool({
      name: "destroy",
      arguments: { name: "no-such-target" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text).toContain("recovery: ");
    expect(JSON.parse(text.slice(text.indexOf("{")))).toMatchObject({ ok: false });
  });

  test("a call missing a required argument is refused by the SDK's own schema validation", async () => {
    const result = (await client.callTool({
      name: "create",
      arguments: { name: "no-slot" },
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("slot");
  });
});
