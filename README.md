# agentbrowse

`agentbrowse` is a flat, polyglot home for native browser-facing applications.
Each language keeps its normal build files at the repository root. The first
application is a Zig/AppKit client for Kernel/Neko Live View.

The application receives one connection descriptor on standard input and
connects immediately. It deliberately has no connection chooser:

```sh
tools/live-view launch local
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

For the local artbird smoke target, the root helper passes the descriptor to
that bundled executable directly:

```sh
tools/live-view start local 0
tools/live-view tunnel local
tools/live-view launch local
```
