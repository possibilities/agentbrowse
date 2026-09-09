# AgentBrowse repository guidance

Read [CONTEXT.md](CONTEXT.md) for Browser profile, Browser target and Live View
lifetimes. Read [architecture](docs/architecture.md) before changing the native
adapter or host boundary, [profiles](docs/profiles.md) before profile lifecycle
work, and the relevant [decision records](docs/adr/) for input, WebRTC and
ownership constraints. [README.md](README.md) owns usage and build procedures.

## Ownership

- Browser profiles are durable user data; targets and Live View attachments
  have separate lifetimes. Closing a view is not permission to delete a profile.
- The native Live View owns its connection and input state. Hosts own layout,
  command routing and target selection; use the supported `agentbrowse/opentui`
  exports rather than reaching into native or adapter internals.
- Keep the pinned WebRTC and OpenTUI package contracts together. A parser,
  JavaScript or native artifact change must retain the matching build provenance.
- `scripts/install-host` owns Hypeman installation and service recovery.
  Ordinary browser launch does not install a host service or acquire an image.
  Preserve unrelated workloads and source profiles.
- Connection descriptors, tokens, browser profiles and signed-in captures are
  private data. Use disposable targets and sanitized fixtures for validation.

## Validation and fleet delivery

Use the toolchain versions in README. `bun run check` runs lint, TypeScript and
Bun tests plus the Zig test suite. Native/frontend behavior changes also need
the relevant build and focused Live View proof described in README; dispose
owned views, input holds and temporary browser targets afterward.

AgentStart invokes the owning installer and ships `skills/browser/` through
`~/code/agentstart/scripts/sync-skills`. Update its `skills/fleet/MAP.md` when a
cross-tool call changes. General doctrine belongs in AgentGuidance; the
Browser runbook and runtime contracts belong here.
