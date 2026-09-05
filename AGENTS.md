# Working in agentbrowse

agentbrowse is one flat, polyglot repository: a Bun/TypeScript CLI that
provisions Kernel browser targets on configured backends (`cli/`, `client/`,
`config/`), a Zig Live View core with an Objective-C++ bridge (`src/`,
`platform/`, `include/`), and an OpenTUI frontend adapter (`src/opentui/`).
`README.md` is the user-facing description; this file is for changing it.

## Language and decisions

- `CONTEXT.md` is the glossary. Use its terms (Browser profile, Browser
  target, Browser provider, Frame lease, Input delivery queue, and the rest)
  in code, tests, docs, and commit messages, and add or amend an entry the
  moment a term is settled.
- Decisions that are hard to reverse and the result of a real trade-off get a
  short ADR in `docs/adr/NNNN-slug.md`: a title plus one to three sentences.
  Read the existing ones before changing transport, input, frame, or profile
  behavior; several encode constraints that the code alone does not explain.

## Validate

```sh
bun run check          # Biome, tsc, bun test, zig build test
bun run native:build   # headless dylib (needs tools/fetch-webrtc once)
```

`bun run check` is the bar for every commit. Native tests that need the dylib
skip when `zig-out` is absent; run `bun run native:build` first when a change
touches the ABI or the OpenTUI adapter.

## Contracts that span files

- The CLI describes itself once, in `cli/contract.ts`. Every help surface,
  `guide --json`, and the MCP tool set render from it. A new command, argument,
  or `error.code` is added there, and the code that throws it must use the
  same string.
- The native ABI version lives in three places that a test pins together:
  `src/live_view_abi.zig`, `include/agentbrowse_live_view.h`, and
  `src/opentui/abi-version.ts`. Extend structs additively and bump all three.
- Both OpenTUI package overrides in `package.json` point at the pinned
  `possibilities/opentui` carry recorded in `config/opentui-carry.json`; a test
  checks the lock and the installed dylib digest against it. Do not bump
  OpenTUI without updating that record, and never pin only the native package.

## Conduct

- Connection descriptors and Live View credentials are never logged, echoed
  to status, or placed in argv.
- The Live View session core writes nothing to stdout or stderr; hosts read
  status through the polling ABI.
- `agentbrowse mcp` owns stdout while it runs; nothing else may print.
- Tests that start processes reap them. The suite must leave no `bun`, `ssh`,
  or Live View process behind.
