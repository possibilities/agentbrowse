# agentbrowse

`agentbrowse` is a flat, polyglot home for browser-facing applications. Each
language keeps its normal build files at the repository root. It currently
contains:

- a Bun/TypeScript CLI that creates Kernel browser targets on Artbird;
- a Zig/AppKit client for interacting with those targets through Kernel/Neko
  Live View.

## Create a browser target

Install the Bun dependencies and expose the checkout's CLI:

```sh
bun install
bun link
```

Each named browser target uses a numeric slot. The slot selects its CDP,
loopback Live View HTTP, and WebRTC UDP ports:

```sh
agentbrowse create testing --slot 1
```

The command prints the target's tailnet-only CDP endpoint. Use it directly
with `agent-browser`:

```sh
agent-browser --cdp http://ARTBIRD_TAILNET_IP:9223 open https://example.com
agent-browser --cdp http://ARTBIRD_TAILNET_IP:9223 snapshot -i
```

Delete only that exact, ownership-labeled container when finished. Its pinned
Kernel image is preserved:

```sh
agentbrowse destroy testing
```

Pass `--json` to either lifecycle command for a stable
`{schema_version,ok,error,data}` envelope. The CLI defaults to the SHA-tagged
image matching `~/src/kernel-images`; `--image` or `AGENTBROWSE_IMAGE` selects
an already-loaded image explicitly.

## Native Live View

The application receives one connection descriptor on standard input and
connects immediately. It deliberately has no connection chooser:

```sh
tools/live-view tunnel testing
tools/live-view launch testing
```

For a descriptor supplied by another integration:

```sh
zig build run -- --connection-stdin <path/to/connection.json
```

Connection descriptors can contain credentials or signed URLs. Keep descriptor
files mode `0600`, never pass their contents on the command line, and do not
commit them. See `docs/connection-descriptor.md` and `docs/local-runtime.md`.
The observed signaling contract is in `docs/protocol.md`; reusable frontend
boundaries and initial measurements are in `docs/architecture.md` and
`docs/performance.md`.

## Development target

- macOS 26 or newer on Apple silicon
- Zig 0.16.0
- the pinned LiveKit libwebrtc XCFramework described in
  `docs/adr/0001-native-webrtc-stack.md`

```sh
zig build test
tools/fetch-webrtc
zig build
```

`zig build` produces both `zig-out/bin/kernel-live-view` for command-line
integration and the self-contained `zig-out/Kernel Live View.app` bundle.
`zig build run -- --connection-stdin` runs the bundled executable so its pinned
WebRTC framework is resolved exactly as it is in the packaged application. The
bundle and nested framework receive ad-hoc signatures for local execution; no
distribution identity or notarization credential is used.

For an Artbird browser target, the root helper passes the descriptor to that
bundled executable directly:

```sh
agentbrowse create testing --slot 1
tools/live-view tunnel testing
tools/live-view launch testing
```

## Validate changes

```sh
bun run check
```

This checks the Bun/TypeScript CLI and runs the Zig test suite.
