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

Chromium starts maximized within the remote desktop while retaining its tab
strip and address bar. The non-interactive Chrome for Testing banner is hidden
so the page receives the full remaining viewport.

List every browser target carrying agentbrowse ownership labels:

```sh
agentbrowse list
agentbrowse list --json
```

The list includes stopped and failed-created containers as well as running
ones. A `!` beside the state means more than one target records the same slot.
`create` refuses a slot already recorded by another managed target before it
asks Docker to start a container.

The command prints the target's tailnet-only CDP endpoint. Use it directly
with `agent-browser`:

```sh
agent-browser --cdp http://ARTBIRD_TAILNET_IP:9223 open https://example.com
agent-browser --cdp http://ARTBIRD_TAILNET_IP:9223 snapshot -i
```

## Use Artbird as an agent-browser provider

Configure agent-browser to run the `agentbrowse provider` subcommand as a
`browser.provider` plugin. Add this entry to the `plugins` array in the
project's `agent-browser.json`, or in `~/.agent-browser/config.json` for global
use:

```json
{
  "plugins": [
    {
      "name": "artbird",
      "command": "agentbrowse",
      "args": ["provider"],
      "capabilities": ["browser.provider"]
    }
  ]
}
```

Launch an agent-browser session through Artbird:

```sh
agent-browser --session research --provider artbird open https://example.com
agent-browser --session research --provider artbird snapshot -i
agent-browser --session research --provider artbird close
```

Set `AGENT_BROWSER_PROVIDER=artbird` to omit `--provider artbird` from each
command.

The provider uses the agent-browser session name as the Browser target name
when it already matches the target grammar. Other valid agent-browser session
names receive a stable safe target name. A launch reuses the matching target
when it already exists or allocates the first free slot and creates it. Close
always destroys the target, including one that was already running when the
provider received the launch request.

No provider server runs locally. agent-browser starts `agentbrowse provider`
for one `plugin.manifest`, `browser.launch`, or `browser.close` request; the
subcommand responds over standard output and exits. The agent-browser daemon
then connects directly to the returned Tailnet-only CDP URL.

For an editable fleet installation, run `scripts/install.sh --install`. It
installs frozen Bun dependencies, links `~/.local/bin/agentbrowse` to this
checkout, and records the deployed Git commit under
`~/.local/state/agentbrowse/deployed-sha`.

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

Open a provider-managed Browser target by its agent-browser session name:

```sh
agentbrowse view
```

`view` applies the same stable session-to-target mapping as the Artbird
provider, then owns the Live View SSH tunnel until the GUI closes. The Browser
target must already exist; create it first with an agent-browser command such
as `agent-browser open https://example.com`. Pass a session name to both
commands when using a session other than `default`.

The application receives one connection descriptor on standard input and
connects immediately. It deliberately has no connection chooser:

```sh
tools/live-view launch testing
```

`launch` opens the SSH forwarding connection needed by Live View, waits for
it to become ready, and closes it when the application exits.

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
tools/live-view launch testing
```

## Validate changes

```sh
bun run check
```

This checks the Bun/TypeScript CLI and runs the Zig test suite.
