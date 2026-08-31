/**
 * The contract → MCP mapping, whole, in one file.
 *
 * `agentstart/config/agent-contract/MCP.md` is the normative specification and
 * this module implements exactly it: which leaves become tools, how names and
 * input schemas are built, how each constraint maps, how the annotations are
 * derived, what the server's instructions carry, and how a tool call becomes a
 * CLI invocation. Nothing here decides which commands an agent may call — the
 * contract already answered that in `audience`, and a mapper that
 * second-guessed it would have moved the decision back to the consumer.
 *
 * Six sibling CLIs carry the same mapping, so it is deliberately dull and
 * mirrors AgentBoard's `mcp-tools.ts` line for line wherever the two
 * contracts agree. One thing differs, because agentbrowse's own contract
 * shape differs rather than because the mapping does:
 *
 *  - `CONTRACT` in `contract.ts` is already a fully typed, static `Contract`
 *    (it takes no runtime argument the way AgentBoard's `buildContract(dbPath)`
 *    does), so this file reads `Contract` directly instead of hand-declaring a
 *    `ContractDocument` subset to stand in for a `guide --json` result typed
 *    `unknown`.
 *
 * Nothing in here imports the MCP SDK: the mapping is a description of tools,
 * and `mcp-server.ts` is what hands that description to a server.
 */

import * as z from "zod/v4";
import {
  type Contract,
  type ContractArgument,
  type ContractCommand,
  constraintSentence,
} from "./contract.ts";

/** The four hints MCP carries. Declared here rather than imported so this file
 * stays SDK-free; the shape is `ToolAnnotations` and is checked structurally. */
export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface AgentTool {
  /** The command's full path joined with `_`, never prefixed with the CLI name:
   * the host already namespaces by server. */
  name: string;
  /** The same path unjoined. */
  path: string[];
  title: string;
  description: string;
  /** Advertised as JSON Schema and used to validate the call. */
  input: z.ZodObject<Record<string, z.ZodType>>;
  annotations: ToolAnnotations;
  /** Exactly the arguments the schema above exposes — the leaf's own plus any
   * `call` global. */
  arguments: ContractArgument[];
  leaf: ContractCommand;
}

// --- Which commands become tools ---

/**
 * Exactly the leaves whose `audience` is `agent`: not groups, which are not
 * invocable, and not `operator` or `internal` — `mcp` and `provider` included.
 *
 * The leaf's own audience decides, never its group's.
 */
function agentLeaves(
  commands: readonly ContractCommand[],
  prefix: string[] = [],
): { path: string[]; leaf: ContractCommand }[] {
  return commands.flatMap((command) => {
    const path = [...prefix, command.name];
    if (command.subcommands !== undefined) return agentLeaves(command.subcommands, path);
    return command.audience === "agent" ? [{ path, leaf: command }] : [];
  });
}

// --- Input schema ---

/**
 * `--slot` → `slot`, `name` → `name`. A flag and a positional differing only
 * by the dashes would collide; no fleet contract has that pair, and the
 * dispatcher looks each argument back up by its contract name, so nothing
 * depends on this spelling beyond being typeable.
 */
function propertyName(name: string): string {
  return name.replace(/^--/, "");
}

/** MCP.md: a `ref` stays a string, and the caller is told that a label or an
 * unambiguous phrase resolves — otherwise it hunts for an id it never needs.
 * No agentbrowse argument uses `format: "ref"` today; kept for the leaf that
 * eventually does, so the mapping does not have to be relearned then. */
const REF_NOTE =
  "Accepts an item id, its label, or any unambiguous phrase from one; ids are opaque and are never the normal way to name an item. Call resolve when a phrase could name two.";

/** MCP.md: an `out` path is a destination the command writes, and the caller
 * did not choose the working directory a relative one resolves against. */
const OUT_PATH_NOTE =
  "The command WRITES this path. A relative path resolves against a working directory this caller did not choose, and an existing file is overwritten.";

function csvNote(argument: ContractArgument): string {
  return argument.format === "ref"
    ? "Comma-joined into one string, each entry an item reference."
    : "Comma-joined into one string.";
}

function propertyDescription(argument: ContractArgument): string {
  const parts = [argument.description];
  if (argument.format === "ref") parts.push(REF_NOTE);
  if (argument.csv === true) parts.push(csvNote(argument));
  if (argument.format === "path" && argument.direction === "out") parts.push(OUT_PATH_NOTE);
  return parts.join(" ");
}

/**
 * The contract's four scalars, verbatim. `choices` becomes an enum — the
 * fleet has no non-string choice list.
 */
function scalar(argument: ContractArgument): z.ZodType {
  if (argument.type === "boolean") return z.boolean();
  if (argument.choices !== undefined) return z.enum(argument.choices as [string, ...string[]]);
  if (argument.type === "string") return z.string();
  let numeric = argument.type === "integer" ? z.number().int() : z.number();
  if (argument.minimum !== undefined) numeric = numeric.min(argument.minimum);
  if (argument.maximum !== undefined) numeric = numeric.max(argument.maximum);
  return numeric;
}

function property(argument: ContractArgument): z.ZodType {
  // `repeatable` without `csv` is an array of the scalar; `repeatable` AND
  // `csv` is also an array, and is comma-joined when invoked.
  const base = argument.repeatable === true ? z.array(scalar(argument)) : scalar(argument);
  const described = base.describe(propertyDescription(argument));
  // A default makes the property optional in the input schema on its own, which
  // is why it is checked before `required`.
  if (argument.default !== undefined) return described.default(argument.default as never);
  return argument.required === true ? described : z.optional(described);
}

/**
 * A leaf's own arguments, plus the globals whose `role` is `call`.
 *
 * agentbrowse's only two globals are `--json` (`output-format`) and `--help`
 * (`meta`), so this suppresses both: the caller has already fixed the output
 * shape by using MCP at all, and asking a model to choose `--help` is asking
 * it to guess.
 */
function callArguments(document: Contract, leaf: ContractCommand): ContractArgument[] {
  const globals = document.global_arguments.filter(
    (argument) => (argument.role ?? "call") === "call",
  );
  return [...(leaf.arguments ?? []), ...globals];
}

// --- Constraints ---

/**
 * Expressed in the schema where JSON Schema can, and in the description ALWAYS.
 * A schema-only rule is invisible in most host UIs, and a caller that cannot see
 * a rule breaks it.
 */
interface MappedConstraints {
  keywords: Record<string, unknown>;
  sentences: string[];
}

/** `oneOf`/`anyOf` of single-property `required` shapes, per MCP.md. */
function eitherOf(members: string[]): { required: string[] }[] {
  return members.map((member) => ({ required: [member] }));
}

function mapConstraints(leaf: ContractCommand): MappedConstraints {
  const keywords: Record<string, unknown> = {};
  const sentences: string[] = [];
  for (const constraint of leaf.constraints ?? []) {
    // Said in the CLI's own words, with the arguments spelled as the properties
    // this schema advertises rather than as flags.
    sentences.push(constraintSentence(constraint, propertyName));
    const members = constraint.arguments.map(propertyName);
    switch (constraint.kind) {
      case "one_of":
        // Nothing in JSON Schema says "at most one" without `not`, which is
        // legal and unreadable in practice; there the sentence is the whole
        // mapping.
        if (constraint.required === true) keywords["oneOf"] = eitherOf(members);
        break;
      case "at_least_one":
        keywords["anyOf"] = eitherOf(members);
        break;
      case "requires":
        keywords["dependentRequired"] = { [members[0]!]: members.slice(1) };
        break;
      case "conflicts":
        // Expressible as `not`/`allOf` and unreadable as either; described only.
        break;
    }
  }
  return { keywords, sentences };
}

// --- Annotations ---

/** Verbs that remove or overwrite, shared fleet-wide. */
const REMOVING_VERBS = new Set([
  "rm",
  "remove",
  "delete",
  "destroy",
  "gc",
  "prune",
  "purge",
  "clear",
  "unlink",
  "unrelate",
]);

/**
 * Full paths whose repeat call is NOT a no-op. Empty for agentbrowse, unlike
 * AgentBoard's `add`: `create` and `profile create` both report `created:
 * false` and hand back the existing target or profile on a repeat instead of
 * making a second one, and `destroy` / `profile delete` already tolerate an
 * absent target by reporting `destroyed: false` / `deleted: false`. Nothing
 * here appends.
 */
const APPENDING: ReadonlySet<string> = new Set<string>();

/**
 * Full paths that reach a configured backend. Unlike AgentBoard, whose store
 * is a local SQLite file, agentbrowse's backends carry a `remoteHost` and a
 * `networkAddress`/`networkAddressCommand` (`config/deployment.ts`), and its
 * own error codes name unreachable and unresolved hosts. Every leaf that
 * touches the farm is therefore open-world; only `guide`, which reads the
 * static in-process contract, is not.
 */
const NETWORK: ReadonlySet<string> = new Set([
  "create",
  "list",
  "destroy",
  "profile create",
  "profile list",
  "profile delete",
  "resolve",
  "view",
]);

/**
 * The two lists above, exported for the test that pins them against the
 * contract: a list naming a command nobody has is a list that has rotted, and
 * an annotation is the one place where nothing else would notice.
 */
export const ANNOTATION_EXCEPTIONS: {
  appending: ReadonlySet<string>;
  network: ReadonlySet<string>;
} = {
  appending: APPENDING,
  network: NETWORK,
};

function annotations(path: string[], leaf: ContractCommand): ToolAnnotations {
  const full = path.join(" ");
  const writesOut = (leaf.arguments ?? []).some(
    (argument) => argument.format === "path" && argument.direction === "out",
  );
  return {
    readOnlyHint: leaf.mutates === false,
    destructiveHint: leaf.mutates === true && (REMOVING_VERBS.has(leaf.name) || writesOut),
    idempotentHint: !APPENDING.has(full),
    openWorldHint: NETWORK.has(full),
  };
}

// --- Description ---

function toolDescription(
  document: Contract,
  path: string[],
  leaf: ContractCommand,
  sentences: string[],
): string {
  const parts: string[] = [];
  // MCP.md: a blocking command says so in the FIRST sentence, because a host
  // with a request timeout has no other way to know.
  if (leaf.blocking === true) {
    parts.push("Blocks: this waits on something outside the CLI and may not return promptly.");
  }
  parts.push(`${leaf.summary}.`);
  // The guidance below quotes CLI invocations; this is what makes them legible.
  parts.push(`Runs \`${document.meta.name} ${path.join(" ")}\` in this process.`);
  parts.push(...sentences);
  if (leaf.guidance !== undefined) parts.push(leaf.guidance);
  return parts.join("\n\n");
}

// --- The surface ---

export function agentTools(document: Contract): AgentTool[] {
  return agentLeaves(document.commands).map(({ path, leaf }) => {
    const exposed = callArguments(document, leaf);
    const shape: Record<string, z.ZodType> = {};
    for (const argument of exposed) {
      shape[propertyName(argument.name)] = property(argument);
    }
    const { keywords, sentences } = mapConstraints(leaf);
    return {
      name: path.join("_"),
      path,
      title: leaf.summary,
      description: toolDescription(document, path, leaf, sentences),
      input: z.object(shape).meta(keywords),
      annotations: annotations(path, leaf),
      arguments: exposed,
      leaf,
    };
  });
}

/**
 * The server's `instructions`: the contract's `guidance`, then what `concepts`
 * says a caller must know — the envelope, the error codes with their
 * recovery, and `agent_defaults`. This is the half of the contract a tool
 * schema cannot carry, and dropping it ships a surface that works and is used
 * wrongly. `guidance` already narrates the session/profile/target/slot/backend
 * model in prose, which is why `concepts.model`'s structured glossary is not
 * repeated here — MCP.md names exactly guidance, envelope, error codes, and
 * agent_defaults, and the glossary would be a second telling of what guidance
 * already says.
 */
export function serverInstructions(document: Contract): string {
  const envelope = Object.entries(document.concepts.output_contract.envelope)
    .map(([field, meaning]) => `  ${field}: ${meaning}`)
    .join("\n");
  const errors = document.concepts.error_codes
    .map((entry) =>
      entry.recovery === undefined
        ? `  ${entry.code} — ${entry.meaning}`
        : `  ${entry.code} — ${entry.meaning} → ${entry.recovery}`,
    )
    .join("\n");
  const defaults = document.concepts.agent_defaults.map((line) => `  ${line}`).join("\n");
  return `${document.guidance}

Every tool returns ${document.meta.name}'s own envelope as JSON text:
${envelope}

A refusal comes back as a tool error whose first line is the error code, then
the message, then the recovery when there is one. The recovery line is the
difference between a caller that retries correctly and one that retries
identically, so read it before calling again.

Error codes
${errors}

Opening moves
${defaults}
`;
}
