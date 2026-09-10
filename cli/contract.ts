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
  readonly csv?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
  /** What kind of knob this is, for a consumer building a call surface.
   * Absent means `call`. AgentBrowse's two globals are `output-format` and
   * `meta`, so both are suppressed from that surface and neither is ever
   * `call` by omission here. */
  readonly role?: "call" | "output-format" | "store-selection" | "meta";
}

export interface ContractStdin {
  readonly accepts: "text" | "json";
  readonly required?: boolean;
  readonly description: string;
}

export interface ContractConstraint {
  readonly kind: "one_of" | "at_least_one" | "conflicts" | "requires";
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
  /** The command waits on something outside itself and may not return
   * promptly. `mcp` is the one command here that sets it: it serves until its
   * transport closes, and a caller with a request timeout needs to know
   * before it calls, not after it hangs. */
  readonly blocking?: boolean;
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

A session is a task's driver identity. New sessions are disposable by default:
open one with agent-browser, then close it to remove both VM and temporary
profile storage. Before a task needing saved sign-ins, call session prepare
SESSION --profile personal. That leases the saved profile exclusively; successive
owners accumulate sign-ins in it. profile_leased means wait for the owner,
not drive their session. Existing profiles from earlier versions stay saved.

Only a target name addresses a live browser. Resolve SESSION and read
.data.target.name for human handoff; never substitute the session or profile.
While the human may control that target, do not issue driver commands.
Close through agent-browser only after every handoff is terminal. Saved profiles
survive; disposable profiles are deleted. Direct destroy preserves a profile
and is not the normal session cleanup operation.

At most 16 unfinished disposable sessions are retained, including failed
launches. If the driver reports a generic plugin failure, inspect session list.
After confirming your task and human handoffs have ended, session release
SESSION --lease LEASE recovers that exact receipt. Failed shutdown retains
state for recovery. No timer steals an active lease. Do not release other
agents' sessions based only on age. Saved profile deletion requires an explicit
request to remove that state.

view is the handoff verb, and it opens the Live View on the operator's own
display. Prefer the attention skill for a durable human interaction with an
outcome an agent can wait on; reach for view when the human is present and
wants to look now.`;

const ERROR_CODES: readonly ContractErrorCode[] = [
  {
    code: "invalid_session",
    meaning: "The driver session name is empty, too long, or contains control characters.",
  },
  {
    code: "invalid_session_receipt",
    meaning: "A provider session receipt is malformed; no automatic cleanup is attempted.",
  },
  {
    code: "session_already_prepared",
    meaning: "This session already owns another profile.",
    recovery: "Close or release the current lease before selecting another profile.",
  },
  {
    code: "profile_leased",
    meaning: "A saved profile already belongs to another session or target.",
    recovery: "Wait for its owner to close; never use their driver session or steal the lease.",
  },
  {
    code: "disposable_capacity_exhausted",
    meaning: "All 16 unfinished disposable session slots are occupied.",
    recovery:
      "Inspect session list and release only exact leases whose work and human handoffs have ended.",
  },
  {
    code: "session_target_changed",
    meaning: "Cleanup found a different or ambiguous target and refused to act.",
  },
  {
    code: "profile_exists",
    meaning: "An import would replace an existing Browser profile.",
    recovery: "Import into a new profile name.",
  },
  {
    code: "profile_archive_exists",
    meaning: "The requested export file already exists.",
    recovery: "Choose a new archive path.",
  },
  { code: "invalid_profile_archive", meaning: "The file is not a Kernel tar.zst profile archive." },
  {
    code: "profile_import_pending",
    meaning: "An import has not completed; launches cannot use this profile.",
    recovery:
      "Destroy its temporary target if present, then retry the import or delete the new profile.",
  },
  {
    code: "profile_not_quiescent",
    meaning: "Kernel could not confirm Chromium stopped and its filesystem synced.",
  },
  {
    code: "profile_shutdown_failed",
    meaning: "The Browser target was retained because its profile could not be stopped and synced.",
    recovery: "Retry destroy; --force explicitly abandons unflushed browser writes.",
  },
  {
    code: "kernel_request_failed",
    meaning: "Kernel's native browser API failed or returned an invalid response.",
  },
  {
    code: "profile_cleanup_failed",
    meaning: "An archive operation could not remove its temporary Browser target.",
    recovery: "Inspect and destroy the named temporary target before retrying.",
  },
  {
    code: "allocation_busy",
    meaning: "Another browser target or profile lifecycle operation holds the allocation lock.",
    recovery: "Retry the command; the lock is held only for the length of one operation.",
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
    code: "hypeman_credentials_missing",
    meaning: "The configured Hypeman token file is absent, unreadable, or empty.",
    recovery: "Prepare the private token file for this exact backend.",
  },
  {
    code: "hypeman_request_failed",
    meaning: "The Hypeman API refused or failed an operation.",
    recovery:
      "Inspect the exact instance and server logs before retrying; mutations never fall through to another backend.",
  },
  {
    code: "hypeman_network_failed",
    meaning: "The remote Hypeman forwarding table could not be reconciled.",
    recovery:
      "Run the repository-managed Hypeman host setup and inspect the exact target before retrying.",
  },
  {
    code: "invalid_hypeman_response",
    meaning: "The Hypeman API returned malformed or incomplete data.",
    recovery: "Verify the pinned Hypeman runtime and backend configuration.",
  },
  {
    code: "profile_missing",
    meaning: "The profile volume disappeared before instance creation.",
    recovery: "Inspect this backend's exact profile and its durable binding before retrying.",
  },
  {
    code: "invalid_configuration",
    meaning: "The agentbrowse deployment configuration is missing, unreadable, or invalid.",
    recovery: "Repair the deployment configuration; agentbrowse does not fall back to defaults.",
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
];

/**
 * One constraint, in the CLI's own words, with its arguments spelled however
 * the caller asked (a consumer building a call surface passes a `spell` that
 * renders them as its own schema's properties instead of as flags). Read by
 * `mcp-tools.ts`, which cannot invent this prose without re-authoring the
 * relation `constraints[]` already states.
 */
export function constraintSentence(
  constraint: ContractConstraint,
  spell: (name: string) => string = (name) => name,
): string {
  const members = constraint.arguments.map(spell);
  const list = members.join(", ");
  let head: string;
  switch (constraint.kind) {
    case "one_of":
      head = `Give ${constraint.required === true ? "exactly" : "at most"} one of ${list}.`;
      break;
    case "at_least_one":
      head = `Give at least one of ${list}.`;
      break;
    case "requires":
      head = `${members[0]!} requires ${members.slice(1).join(", ")}.`;
      break;
    case "conflicts":
      head = `${list} may not be combined.`;
      break;
  }
  return constraint.description === undefined ? head : `${head} ${constraint.description}`;
}

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
        "Browser cookies, storage and authentication. Saved profiles outlive tasks; disposable profiles are removed on close. Select personal explicitly before authenticated work.",
      target:
        "One live container incarnation of a profile: the only name that addresses a running browser, and the exact object handed to a human.",
      slot: "A port slot from 0 to 999 fixing a target's CDP, Live View HTTP, and WebRTC ports. One target per slot.",
      backend:
        "A configured Hypeman host tried in configured order. A profile binds to the backend that first created it.",
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
    read_only_commands: ["list", "profile list", "session list", "resolve", "guide"],
    agent_defaults: [
      "Resolve, never guess: `agentbrowse resolve SESSION --json` names the exact live target incarnation.",
      "Let agent-browser provision and close targets through the provider; call create only for a target no driver session owns.",
      "Close task sessions: disposable storage is removed, while explicitly saved profiles retain sign-ins.",
    ],
  },
  global_arguments: [
    {
      name: "--json",
      type: "boolean",
      description:
        "Emit the stable machine envelope. Accepted by every command that produces output; provider speaks its own protocol and view launches a viewer, and both refuse it.",
      role: "output-format",
    },
    {
      name: "--help",
      type: "boolean",
      description: "Show help for the command and exit",
      aliases: ["-h"],
      role: "meta",
    },
  ],
  commands: [
    {
      name: "session",
      summary: "Own disposable browsing or lease a saved profile",
      audience: "agent",
      mutates: true,
      arguments: [],
      subcommands: [
        {
          name: "prepare",
          summary: "Prepare a task session, optionally leasing a saved profile",
          audience: "agent",
          mutates: true,
          guidance:
            "Public browsing needs no preparation: open a unique task session directly and close it to discard its storage. For your saved sign-ins, prepare a unique task session with profile personal before driver open. Only one session may own that profile. Keep the returned lease for recovery; a profile_leased result means wait for its owner, never use their session. Repeating prepare for the same session is idempotent.",
          arguments: [
            { ...SESSION_ARGUMENT, required: true },
            {
              name: "--profile",
              type: "string",
              description:
                "Saved profile to lease; use personal for accumulated human sign-ins. Omit for disposable browsing.",
            },
          ],
        },
        {
          name: "list",
          summary: "List owned sessions, profile retention, exact leases and targets",
          audience: "agent",
          mutates: false,
          arguments: [],
          guidance:
            "Prepared and failed sessions remain visible until closed or explicitly released. Age alone is not permission to interrupt an agent or human handoff.",
        },
        {
          name: "release",
          summary: "Recover one exact session lease and clean up its browser",
          audience: "agent",
          mutates: true,
          guidance:
            "Normally close through the driver. For a failed launch or abandoned session, release its exact lease only after confirming no active work or human handoff remains. Removes disposable storage; preserves saved profiles. A stale lease cannot close a replacement session.",
          arguments: [
            { ...SESSION_ARGUMENT, required: true },
            {
              name: "--lease",
              type: "string",
              required: true,
              description: "Exact lease returned by session prepare or session list",
            },
          ],
        },
      ],
    },
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
          minimum: 0,
          maximum: 999,
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
      arguments: [
        NAME_ARGUMENT,
        {
          name: "--force",
          type: "boolean",
          description:
            "Delete an unresponsive VM without stopping Chromium; may lose unflushed writes",
        },
      ],
    },
    {
      name: "profile",
      summary: "Manage durable Browser profiles and native Kernel archives",
      audience: "agent",
      subcommands: [
        {
          name: "export",
          summary: "Export an idle Browser profile as Kernel's native tar.zst archive",
          audience: "agent",
          mutates: true,
          guidance:
            "Close the profile's current target first. A temporary target lets Kernel stop Chromium, sync the filesystem, and stream its native archive. The temporary target is removed. The destination is private and never overwritten. Archives contain authentication state.",
          arguments: [
            {
              name: "name",
              type: "string",
              description: "Browser profile name",
              positional: true,
              required: true,
            },
            {
              name: "path",
              type: "string",
              format: "path",
              direction: "out",
              description: "New local tar.zst file",
              positional: true,
              required: true,
            },
          ],
        },
        {
          name: "import",
          summary: "Import a Kernel profile archive into a new durable Browser profile",
          audience: "agent",
          mutates: true,
          guidance:
            "Kernel owns archive extraction and its stop/apply/start lifecycle. Existing profiles are refused. An interrupted import remains reserved and cannot launch; after removing any temporary target, repeat import with the intended archive to finish it. The source archive is retained. Optional --backend selects the new profile's home explicitly.",
          arguments: [
            {
              name: "name",
              type: "string",
              description: "New Browser profile name",
              positional: true,
              required: true,
            },
            {
              name: "path",
              type: "string",
              format: "path",
              direction: "in",
              description: "Local Kernel tar.zst archive",
              positional: true,
              required: true,
            },
            {
              name: "--backend",
              type: "string",
              description: "Configured backend ID; defaults to the first available backend",
            },
          ],
        },
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
      blocking: true,
      guidance:
        "Opens the operator's own display on the live target, for a human who is present and wants to look now. For a durable handoff with an outcome an agent can wait on, create an attention item against the resolved target name instead. Waits for the Live View app itself to exit, which normally means the human closed it.",
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
    {
      name: "mcp",
      summary: "Serve a stdio MCP server generated from this contract",
      audience: "internal",
      mutates: true,
      blocking: true,
      guidance:
        "Every audience: agent leaf above becomes a tool, generated from this contract at start-up; adding one here adds a tool with no further edit. provider stays hidden because its audience is internal, and so does mcp itself. Dispatch happens in this same process, through the exact functions create, list, destroy, profile, resolve, and view already call — nothing is spawned and no argv is re-parsed. The server therefore owns the same three responsibilities as the CLI: browser target lifecycle, session resolution, and human handoff through view. Page interaction — clicking, typing, snapshots — stays with the third-party agent-browser CLI and is deliberately absent here.",
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
        : constraint.kind === "at_least_one"
          ? "at least one of"
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
