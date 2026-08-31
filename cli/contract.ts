/**
 * The one authored description of this CLI.
 *
 * `agentbrowse guide --json` publishes this document as the fleet agent
 * contract, version 1. `--help`, `--agent-help`, and `--agent-teaser` are
 * renders of it and never a second authorship: a command, an argument, a
 * refusal code, or a piece of routing judgment is written here once, and every
 * surface that shows it reads it from here.
 */

import packageJson from "../package.json";

export interface ContractArgument {
  readonly name: string;
  readonly type: "string" | "boolean" | "integer" | "number";
  readonly description: string;
  readonly format?: "path" | "url" | "duration" | "ref" | "json";
  readonly direction?: "in" | "out";
  readonly required?: boolean;
  readonly positional?: boolean;
  readonly repeatable?: boolean;
  readonly choices?: readonly string[];
  readonly default?: unknown;
  readonly aliases?: readonly string[];
}

export interface ContractStdin {
  readonly accepts: "text" | "json";
  readonly required?: boolean;
  readonly description: string;
}

export interface ContractConstraint {
  readonly kind: "one_of" | "conflicts" | "requires";
  readonly arguments: readonly string[];
  readonly required?: boolean;
  readonly description?: string;
}

export interface ContractCommand {
  readonly name: string;
  readonly summary: string;
  readonly audience: "agent" | "operator" | "internal";
  readonly mutates?: boolean;
  readonly guidance?: string;
  readonly arguments?: readonly ContractArgument[];
  readonly subcommands?: readonly ContractCommand[];
  readonly stdin?: ContractStdin;
  readonly constraints?: readonly ContractConstraint[];
}

export interface ContractErrorCode {
  readonly code: string;
  readonly meaning: string;
  readonly recovery?: string;
}

export interface Contract {
  readonly contract_version: 1;
  readonly meta: {
    readonly name: string;
    readonly version: string;
    readonly purpose: string;
    readonly audience: "agent" | "operator";
  };
  readonly guidance: string;
  readonly concepts: {
    readonly model: Record<string, string>;
    readonly output_contract: {
      readonly envelope: Record<string, string>;
      readonly exit_codes: Record<string, string>;
    };
    readonly error_codes: readonly ContractErrorCode[];
    readonly read_only_commands: readonly string[];
    readonly agent_defaults: readonly string[];
  };
  readonly global_arguments: readonly ContractArgument[];
  readonly commands: readonly ContractCommand[];
}

const GUIDANCE = `agentbrowse owns browser target lifecycle, session resolution, and human
handoff. It does not touch pages. Clicking, typing, snapshots, refs, tabs,
waits, uploads, and downloads belong to the third-party agent-browser CLI,
which drives the target agentbrowse provisioned; that boundary is deliberate,
and nothing here reads or manipulates page content.

Three lifetimes are deliberately distinct, and confusing them is the mistake
this tool exists to prevent:

  session  the stable name an agent puts on every agent-browser command
  profile  the durable volume holding cookies, storage, and authentication
  target   one live container incarnation, addressable and short-lived

Only a target name addresses a live browser. When a human must take over the
exact prepared page, run \`agentbrowse resolve SESSION --json\` and read
.data.target.name from the successful envelope; never substitute the session
or profile name for that incarnation, and never keep a resolved name across a
relaunch.

On a machine configured this way, agent-browser launches sessions through
agentbrowse's provider, so an agent normally never calls create or destroy at
all: launching the session provisions the target, and \`agent-browser close\`
destroys it. Reach for create only for a target that is not backed by a driver
session, and for destroy only to reclaim capacity from one that is stranded.
The farm is finite; backend_capacity_exhausted, slot_in_use, and no_free_slots
all mean some earlier target was never released.

Destroying a target preserves its Browser profile, and therefore its
authentication, on purpose. Deleting the profile is the irreversible one:
\`profile delete\` discards a human's signed-in state, so do it only when the
human explicitly asks to remove that browser state permanently.

view is the handoff verb, and it opens the Live View on the operator's own
display. Prefer the attention skill for a durable human interaction with an
outcome an agent can wait on; reach for view when the human is present and
wants to look now.`;

const ERROR_CODES: readonly ContractErrorCode[] = [
  {
    code: "allocation_busy",
    meaning: "Another browser target or profile lifecycle operation holds the allocation lock.",
    recovery: "Retry the command; the lock is held only for the length of one operation.",
  },
  {
    code: "apple_application_root_mismatch",
    meaning:
      "The Apple container service is using a different application-data root than the deployment configuration names.",
    recovery: "Reconcile the machine's agentbrowse-infra deployment before creating targets.",
  },
  {
    code: "apple_foreign_container",
    meaning: "A container on the Apple backend is not an agentbrowse-owned browser target.",
    recovery:
      "Resolve the foreign resource by hand; agentbrowse refuses to touch what it does not own.",
  },
  {
    code: "apple_ownership_missing",
    meaning: "The Apple container application root carries no agentbrowse-infra ownership marker.",
    recovery: "Run the agentbrowse-infra installation before using the Apple backend.",
  },
  {
    code: "apple_ownership_mismatch",
    meaning:
      "The Apple container application root carries an invalid agentbrowse-infra ownership marker.",
    recovery: "Run the agentbrowse-infra installation before using the Apple backend.",
  },
  {
    code: "apple_service_stopped",
    meaning: "The local Apple container service is disabled.",
    recovery: "Run agentbrowse-infra enable, then prepare the locked image explicitly.",
  },
  {
    code: "backend_capacity_exhausted",
    meaning: "The backend already holds its maximum number of browser targets.",
    recovery: "Destroy or close a finished browser target before launching another.",
  },
  {
    code: "browser_backends_not_configured",
    meaning: "No browser backends are configured on this machine.",
    recovery: "Install the version 2 agentbrowse deployment configuration.",
  },
  {
    code: "browser_drift",
    meaning: "An existing container no longer matches the identity agentbrowse recorded for it.",
    recovery: "Destroy the browser target explicitly before recreating it.",
  },
  {
    code: "browser_host_authentication_failed",
    meaning: "Authentication to the remote browser host failed.",
    recovery: "Repair the host's credentials; agentbrowse never prompts for them.",
  },
  {
    code: "browser_host_not_accepting_connections",
    meaning: "The browser host refused the connection.",
  },
  {
    code: "browser_host_unreachable",
    meaning: "The browser host is offline or unreachable.",
  },
  {
    code: "browser_host_unresolved",
    meaning: "The browser host name could not be resolved.",
  },
  {
    code: "browser_missing",
    meaning: "The browser target's container is absent from its backend.",
    recovery: "Destroy the target to clear its runtime metadata, then create or relaunch it.",
  },
  {
    code: "browser_not_ready",
    meaning: "The container was created but CDP and Live View did not become ready in time.",
    recovery: "Inspect the container on its backend, then destroy the target and retry.",
  },
  {
    code: "browser_service_unavailable",
    meaning: "The container engine on the browser host is not running.",
  },
  {
    code: "browser_target_not_found",
    meaning: "The session's Browser profile has no currently bound target.",
    recovery: "Launch the agent-browser session before resolving its browser target.",
  },
  {
    code: "browser_target_not_running",
    meaning: "The session's bound browser target exists but is not running.",
    recovery: "Restart the agent-browser session before resolving or handing off its target.",
  },
  {
    code: "browser_target_resolve_timeout",
    meaning: "Resolving the session's browser target exceeded fifteen seconds.",
    recovery: "Check the configured browser host and retry.",
  },
  {
    code: "browser_target_slot_conflict",
    meaning: "The session's browser target shares its port slot with another target.",
    recovery: "Destroy the stale target before resolving the agent-browser session.",
  },
  {
    code: "cleanup_backend_unavailable",
    meaning:
      "A target with no backend-bound receipt cannot be destroyed safely because some configured backend is unavailable.",
    recovery: "Restore every configured backend, then destroy the target.",
  },
  {
    code: "command_failed",
    meaning: "A backend command failed for a reason agentbrowse could not classify.",
  },
  {
    code: "foreign_container",
    meaning:
      "A container's ownership labels do not identify it as this browser target, so agentbrowse refused to delete it.",
    recovery:
      "Inspect the container by hand; a mismatch means something outside agentbrowse created or renamed it.",
  },
  {
    code: "image_missing",
    meaning: "The requested Kernel image is not present on the backend.",
    recovery: "Prepare the locked image on that backend, then retry.",
  },
  {
    code: "invalid_apple_response",
    meaning: "The Apple container service returned malformed, incomplete, or ambiguous data.",
  },
  {
    code: "invalid_configuration",
    meaning: "The agentbrowse deployment configuration is missing, unreadable, or invalid.",
    recovery: "Repair the deployment configuration; agentbrowse does not fall back to defaults.",
  },
  {
    code: "invalid_docker_response",
    meaning: "Docker returned malformed or incomplete data.",
  },
  {
    code: "invalid_network_address",
    meaning: "A configured or reported browser network address is not a valid address.",
  },
  {
    code: "invalid_profile_binding",
    meaning: "A durable Browser profile binding record is malformed.",
  },
  {
    code: "invalid_ready_timeout",
    meaning: "The configured browser readiness timeout is outside one to 120 seconds.",
  },
  {
    code: "invalid_target_receipt",
    meaning: "A browser target receipt is malformed or of an unsupported version.",
    recovery: "Destroy the target to discard the receipt, then create it again.",
  },
  {
    code: "no_backend_available",
    meaning: "No configured browser backend is currently available.",
    recovery: "Bring a backend up; the message names why each one was rejected.",
  },
  {
    code: "no_free_slots",
    meaning: "Every browser target port slot from 0 to 999 is in use.",
    recovery: "Destroy an unused browser target before launching another session.",
  },
  {
    code: "profile_backend_conflict",
    meaning:
      "A Browser profile of that name exists on more than one backend and no binding receipt says which is real.",
    recovery: "Inspect each backend and delete only the stale profile.",
  },
  {
    code: "profile_backend_mismatch",
    meaning: "The Browser profile is bound to a different backend than the one being used.",
    recovery: "Use the profile's bound backend so its cookies and authentication remain available.",
  },
  {
    code: "profile_binding_busy",
    meaning: "Another browser lifecycle operation is updating that profile's binding.",
    recovery: "Retry the command.",
  },
  {
    code: "profile_binding_failed",
    meaning: "The container is ready but its durable profile binding could not be written.",
    recovery: "Inspect the container on its backend, then retry the same session.",
  },
  {
    code: "profile_conflict",
    meaning: "The Browser profile is bound to more than one target on the same backend.",
    recovery: "Inspect the conflicting targets and destroy only the stale one.",
  },
  {
    code: "profile_drift",
    meaning: "A volume with the profile's name exists but is not an agentbrowse Browser profile.",
    recovery: "Choose another profile name, or inspect the backend volume before changing it.",
  },
  {
    code: "profile_in_use",
    meaning: "The Browser profile is still mounted by a live browser target.",
    recovery: "Destroy the exact browser target before reusing or deleting its durable profile.",
  },
  {
    code: "profile_not_ready",
    meaning: "The Browser profile was not visible after the backend reported creating it.",
  },
  {
    code: "slot_in_use",
    meaning: "The requested port slot is already used by another browser target.",
    recovery: "Choose another slot, or destroy the occupying target.",
  },
  {
    code: "target_backend_mismatch",
    meaning: "The browser target is bound to a different backend than the one being used.",
  },
  {
    code: "target_identity_conflict",
    meaning: "A backend reported the same browser target more than once.",
  },
  {
    code: "target_inspect_failed",
    meaning: "The container was created but was absent during post-create inspection.",
    recovery: "Inspect the backend, then destroy the target.",
  },
  {
    code: "target_name_unavailable",
    meaning: "No fresh browser target name could be allocated for the profile.",
    recovery: "Retry the agent-browser command.",
  },
  {
    code: "target_profile_backend_mismatch",
    meaning: "The named target and the named profile are bound to different backends.",
    recovery: "Destroy the stale target without deleting its profile, then retry.",
  },
  {
    code: "target_profile_mismatch",
    meaning: "The browser target already records a different Browser profile.",
    recovery: "Destroy the target before binding it to another profile.",
  },
  {
    code: "target_receipt_failed",
    meaning: "The container was created but its backend-bound receipt could not be written.",
    recovery: "Inspect the container on its backend, then destroy the target.",
  },
  {
    code: "target_slot_mismatch",
    meaning: "The browser target already records a different port slot.",
    recovery: "Destroy the target before choosing another slot.",
  },
  {
    code: "unexpected_error",
    meaning: "A failure agentbrowse does not classify; the message carries the underlying text.",
  },
  {
    code: "unknown_backend",
    meaning: "A receipt names a backend that is not configured on this machine.",
  },
  {
    code: "wrong_docker_context",
    meaning: "The configured Docker context does not target its configured endpoint.",
  },
  {
    code: "wrong_docker_engine",
    meaning:
      "The configured Docker context reached a different engine than the configuration names.",
  },
];

const NAME_ARGUMENT: ContractArgument = {
  name: "name",
  type: "string",
  description: "Browser target name; [a-z][a-z0-9-]{0,31}",
  positional: true,
  required: true,
};

const SESSION_ARGUMENT: ContractArgument = {
  name: "session",
  type: "string",
  description: "agent-browser session name, exactly as it is spelled on the driver's commands",
  positional: true,
  default: "default",
};

export const CONTRACT: Contract = {
  contract_version: 1,
  meta: {
    name: "agentbrowse",
    version: packageJson.version,
    purpose:
      "Create durable Kernel browser targets on ordered backends, resolve an agent-browser session to its exact live target, and hand that target to a human.",
    audience: "agent",
  },
  guidance: GUIDANCE,
  concepts: {
    model: {
      session:
        "The stable name an agent puts on every agent-browser command. Names the work, not a browser.",
      profile:
        "A durable backend volume holding cookies, storage, and authentication. Outlives every target and is derived from the session name.",
      target:
        "One live container incarnation of a profile: the only name that addresses a running browser, and the exact object handed to a human.",
      slot: "A port slot from 0 to 999 fixing a target's CDP, Live View HTTP, and WebRTC ports. One target per slot.",
      backend:
        "A configured container host — docker or Apple container — tried in configured order. A profile binds to the backend that first created it.",
    },
    output_contract: {
      envelope: {
        schema_version: "number",
        ok: "boolean",
        error: "{code,message,recovery?} | null",
        data: "payload | null",
      },
      exit_codes: {
        "0": "success",
        "1": "domain failure; with --json the envelope carries ok:false and error.code",
        "2": "usage fault; help is written to standard error and no envelope is emitted",
      },
    },
    error_codes: ERROR_CODES,
    read_only_commands: ["list", "profile list", "resolve", "guide"],
    agent_defaults: [
      "Resolve, never guess: `agentbrowse resolve SESSION --json` names the exact live target incarnation.",
      "Let agent-browser provision and close targets through the provider; call create only for a target no driver session owns.",
      "Destroy finished targets so the finite farm keeps capacity; the profile, and its authentication, survives.",
    ],
  },
  global_arguments: [
    {
      name: "--json",
      type: "boolean",
      description:
        "Emit the stable machine envelope. Accepted by every command that produces output; provider speaks its own protocol and view launches a viewer, and both refuse it.",
    },
    {
      name: "--help",
      type: "boolean",
      description: "Show help for the command and exit",
      aliases: ["-h"],
    },
  ],
  commands: [
    {
      name: "create",
      summary: "Create or start one CDP + Live View browser target",
      audience: "agent",
      mutates: true,
      guidance:
        "Rarely what an agent wants: launching an agent-browser session provisions its target through the provider. Use create for a target no driver session owns. The target is placed on the first available configured backend, or on the profile's already bound backend.",
      arguments: [
        NAME_ARGUMENT,
        {
          name: "--slot",
          type: "integer",
          description: "Port slot from 0 to 999; fixes the CDP, Live View HTTP, and WebRTC ports",
          required: true,
        },
        {
          name: "--profile",
          type: "string",
          description: "Durable Browser profile to mount; defaults to the target name",
        },
        {
          name: "--image",
          type: "string",
          description:
            "Kernel image already loaded on the configured browser host; defaults to the locked headful image",
        },
      ],
    },
    {
      name: "list",
      summary: "List every browser target managed by agentbrowse",
      audience: "agent",
      mutates: false,
      guidance:
        "The inventory across every configured backend, including targets whose slot collides with another and targets that are no longer running.",
      arguments: [],
    },
    {
      name: "destroy",
      summary: "Delete one exactly owned browser target; preserve its Browser profile",
      audience: "agent",
      mutates: true,
      guidance:
        "Destroys the container only. Cookies, storage, and authentication stay in the Browser profile and are there for the next launch. Refuses any container whose ownership labels do not match the named target.",
      arguments: [NAME_ARGUMENT],
    },
    {
      name: "profile",
      summary: "Create, list, or explicitly delete durable Browser profiles",
      audience: "agent",
      subcommands: [
        {
          name: "create",
          summary: "Create one durable Browser profile",
          audience: "agent",
          mutates: true,
          guidance:
            "Creating a target creates its profile as needed, so this is for preparing a profile ahead of any target.",
          arguments: [
            {
              name: "name",
              type: "string",
              description: "Browser profile name; [a-z][a-z0-9-]{0,31}",
              positional: true,
              required: true,
            },
          ],
        },
        {
          name: "list",
          summary: "List durable Browser profiles and the targets mounting them",
          audience: "agent",
          mutates: false,
          arguments: [],
        },
        {
          name: "delete",
          summary: "Permanently delete one durable Browser profile and its stored state",
          audience: "agent",
          mutates: true,
          guidance:
            "Irreversible, and it discards a human's signed-in state. Do it only when the human explicitly asks to remove that browser state; destroying a target is the reversible operation. Refuses while any target still mounts the profile.",
          arguments: [
            {
              name: "name",
              type: "string",
              description: "Browser profile name",
              positional: true,
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: "provider",
      summary: "Handle one agent-browser plugin protocol request over standard I/O",
      audience: "internal",
      mutates: true,
      guidance:
        "The agent-browser plugin protocol handler. agent-browser spawns it; it reads one JSON request from standard input, writes one JSON response, and exits. It is not the envelope and it is nonsense to call directly.",
      stdin: {
        accepts: "json",
        required: true,
        description:
          "One agent-browser.plugin.v1 request object, at most 1 MiB, terminated by end of input",
      },
      arguments: [],
    },
    {
      name: "resolve",
      summary: "Resolve an agent-browser session to its exact current browser target",
      audience: "agent",
      mutates: false,
      guidance:
        "The handoff primitive. Read .data.target.name from the successful envelope and give that to agentattention; the session and profile names do not address a live browser. Fails rather than guessing when the session has no bound target, its target is not running, or its slot collides.",
      arguments: [SESSION_ARGUMENT],
    },
    {
      name: "view",
      summary: "Open a session's browser target in the Live View",
      audience: "agent",
      mutates: true,
      guidance:
        "Opens the operator's own display on the live target, for a human who is present and wants to look now. For a durable handoff with an outcome an agent can wait on, create an attention item against the resolved target name instead.",
      arguments: [SESSION_ARGUMENT],
    },
    {
      name: "guide",
      summary: "Print the machine-readable agent contract",
      audience: "agent",
      mutates: false,
      guidance:
        "With --json, the fleet agent contract, version 1, inside the ordinary envelope. Without it, the same document rendered as the agent runbook.",
      arguments: [],
    },
  ],
};

/* ------------------------------------------------------------------ renders */

const HELP_WIDTH = 88;

function wrap(text: string, indent: string, width = HELP_WIDTH): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (indent.length + candidate.length > width && line !== "") {
      lines.push(indent + line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") lines.push(indent + line);
  return lines;
}

function placeholder(argument: ContractArgument): string {
  return argument.name.replace(/^-+/, "").replace(/-/g, "_").toUpperCase();
}

function usageToken(argument: ContractArgument): string {
  const spelled = argument.positional
    ? placeholder(argument)
    : argument.type === "boolean"
      ? argument.name
      : `${argument.name} ${placeholder(argument)}`;
  return argument.required === true ? spelled : `[${spelled}]`;
}

function optionSpec(argument: ContractArgument): string {
  const spelled = [...(argument.aliases ?? []), argument.name].join(", ");
  return argument.type === "boolean" ? spelled : `${spelled} ${placeholder(argument)}`;
}

interface Leaf {
  readonly path: readonly string[];
  readonly command: ContractCommand;
}

function leaves(commands: readonly ContractCommand[], prefix: readonly string[] = []): Leaf[] {
  const found: Leaf[] = [];
  for (const command of commands) {
    const path = [...prefix, command.name];
    if (command.subcommands === undefined) found.push({ path, command });
    else found.push(...leaves(command.subcommands, path));
  }
  return found;
}

function pad(rows: readonly (readonly [string, string])[], leading = 2, gap = 2): string[] {
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.flatMap(([left, right]) => {
    const indent = " ".repeat(leading + width + gap);
    const wrapped = wrap(right, "", HELP_WIDTH - indent.length);
    const [first = "", ...rest] = wrapped;
    return [
      `${" ".repeat(leading)}${left.padEnd(width)}${" ".repeat(gap)}${first}`.trimEnd(),
      ...rest.map((line) => indent + line),
    ];
  });
}

/** Wrap one item so its continuation lines sit under its own text, not its bullet. */
function hanging(text: string, leading: string, hang: string): string[] {
  const [first = "", ...rest] = wrap(text, "", HELP_WIDTH - leading.length);
  return [leading + first, ...rest.map((line) => hang + line)];
}

export function renderTeaser(): string {
  return `${CONTRACT.meta.purpose}\n`;
}

export function renderHelp(): string {
  const usage = leaves(CONTRACT.commands).map((leaf) => {
    const tokens = (leaf.command.arguments ?? []).map(usageToken);
    return [CONTRACT.meta.name, ...leaf.path, ...tokens].join(" ");
  });

  const options: (readonly [string, string])[] = [];
  const seen = new Set<string>();
  for (const leaf of leaves(CONTRACT.commands)) {
    for (const argument of leaf.command.arguments ?? []) {
      if (argument.positional === true || seen.has(argument.name)) continue;
      seen.add(argument.name);
      options.push([optionSpec(argument), argument.description]);
    }
  }

  const sections = [
    wrap(`${CONTRACT.meta.name}: ${CONTRACT.meta.purpose}`, "").join("\n"),
    ["Usage:", ...usage.map((line) => `  ${line}`)].join("\n"),
    [
      "Commands:",
      ...pad(CONTRACT.commands.map((command) => [command.name, command.summary] as const)),
    ].join("\n"),
    ["Options:", ...pad(options)].join("\n"),
    [
      "Global options:",
      ...pad(
        CONTRACT.global_arguments.map(
          (argument) => [optionSpec(argument), argument.description] as const,
        ),
      ),
    ].join("\n"),
    wrap(
      `Run ${CONTRACT.meta.name} --agent-help for the agent runbook, or ${CONTRACT.meta.name} guide --json for the machine-readable contract.`,
      "",
    ).join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderCommand(leaf: Leaf): string[] {
  const { command } = leaf;
  const heading = `  ${[CONTRACT.meta.name, ...leaf.path].join(" ")} — ${command.summary}`;
  const lines = [
    heading,
    `    audience: ${command.audience}  mutates: ${command.mutates ? "yes" : "no"}`,
  ];
  if (command.guidance !== undefined) lines.push(...wrap(command.guidance, "    "));
  const argumentRows: (readonly [string, string])[] = [];
  for (const argument of command.arguments ?? []) {
    const spelled = argument.positional === true ? placeholder(argument) : optionSpec(argument);
    const notes = [
      argument.required === true ? "required" : undefined,
      argument.repeatable === true ? "repeatable" : undefined,
      argument.choices === undefined ? undefined : `one of ${argument.choices.join(", ")}`,
      argument.default === undefined ? undefined : `default ${JSON.stringify(argument.default)}`,
      argument.direction === "out" ? "written by the command" : undefined,
    ].filter((note): note is string => note !== undefined);
    const suffix = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
    argumentRows.push([spelled, `${argument.description}${suffix}`] as const);
  }
  lines.push(...pad(argumentRows, 6));
  for (const constraint of command.constraints ?? []) {
    const relation =
      constraint.kind === "one_of"
        ? `${constraint.required === true ? "exactly" : "at most"} one of`
        : constraint.kind === "conflicts"
          ? "may not be combined:"
          : "requires:";
    lines.push(...hanging(`${relation} ${constraint.arguments.join(", ")}`, "      ", "        "));
  }
  if (command.stdin !== undefined) {
    lines.push(
      ...hanging(
        `stdin (${command.stdin.accepts}${command.stdin.required === true ? ", required" : ""}): ${command.stdin.description}`,
        "      ",
        "        ",
      ),
    );
  }
  return lines;
}

export function renderAgentHelp(): string {
  const { meta, concepts } = CONTRACT;
  const sections: string[] = [
    `${meta.name} ${meta.version} — agent runbook`,
    wrap(meta.purpose, "").join("\n"),
    CONTRACT.guidance,
    [
      "Model:",
      ...pad(Object.entries(concepts.model).map(([key, value]) => [key, value] as const)),
    ].join("\n"),
    [
      "Opening moves:",
      ...concepts.agent_defaults.flatMap((line) => hanging(`- ${line}`, "  ", "    ")),
    ].join("\n"),
    ["Commands:", ...leaves(CONTRACT.commands).flatMap(renderCommand)].join("\n"),
    [
      "Global options:",
      ...pad(
        CONTRACT.global_arguments.map(
          (argument) => [optionSpec(argument), argument.description] as const,
        ),
      ),
    ].join("\n"),
    [
      "Envelope:",
      ...pad(
        Object.entries(concepts.output_contract.envelope).map(
          ([key, value]) => [key, value] as const,
        ),
      ),
      "  exit codes:",
      ...pad(
        Object.entries(concepts.output_contract.exit_codes).map(
          ([key, value]) => [key, value] as const,
        ),
      ).map((line) => `  ${line}`),
    ].join("\n"),
    wrap(`Read-only commands: ${concepts.read_only_commands.join(", ")}`, "").join("\n"),
    [
      "Error codes:",
      ...concepts.error_codes.flatMap((entry) => [
        ...hanging(`${entry.code} — ${entry.meaning}`, "  ", "    "),
        ...(entry.recovery === undefined ? [] : hanging(`→ ${entry.recovery}`, "    ", "      ")),
      ]),
    ].join("\n"),
  ];
  return `${sections.join("\n\n")}\n`;
}
