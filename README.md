# agentbrowse

`agentbrowse` is a flat, polyglot home for browser-facing applications. Each
language keeps its normal build files at the repository root. It currently
contains:

- a Bun/TypeScript CLI that creates Kernel browser targets backed by durable
  Browser profiles on a configured host;
- a Zig Live View core with AppKit and OpenTUI frontend adapters for
  interacting with those targets through Kernel/Neko.

## Create a browser target

Install the Bun dependencies and expose the checkout's CLI:

```sh
bun install
bun link
```

Copy [`config.example.json`](config.example.json) to
`~/.config/agentbrowse/config.json` and replace its example deployment values.
The file owns host-specific choices: Docker context and identity, SSH host,
network address discovery, image source, browser timezone, provider identity,
and Live View connection settings. `AGENTBROWSE_CONFIG` selects another
absolute path. Environment variables documented in
[`docs/configuration.md`](docs/configuration.md)
override the file for automation, but agentbrowse has no built-in host,
network, checkout, or timezone preference.

`remote.networkAddress` can hold a stable IPv4 address. For a dynamic address,
omit it and set `remote.networkAddressCommand` to a command that prints the
host's IPv4 address; agentbrowse runs that configured command through
`remote.host`. Keep the config private (`chmod 600`) because it can contain Live
View credentials.

Browser profiles and Browser targets have separate lifetimes. A Browser profile
is a durable Docker volume containing Chromium cookies, local storage,
IndexedDB, and authentication state. A Browser target is one Kernel container
incarnation that mounts that profile. Destroying a target preserves its
profile; deleting a profile is always an explicit operation.

Each named Browser target uses a numeric slot. The slot selects its CDP,
loopback Live View HTTP, and WebRTC UDP ports. By default, manual creation uses
the target name as its profile name; `--profile` binds an independently named
profile instead:

```sh
agentbrowse create testing --slot 1
agentbrowse create one-run --profile signed-in --slot 2
```

Chromium starts in ordinary browser fullscreen so the page fills the remote
desktop. Normal shortcuts such as F11, Ctrl+1, and Ctrl+Tab still work. The
non-interactive Chrome for Testing banner is also hidden.

List every browser target carrying agentbrowse ownership labels:

```sh
agentbrowse list
agentbrowse list --json
```

The list includes each target's profile, plus stopped and failed-created
containers as well as running ones. A `!` beside the state means more than one
target records the same slot. `create` refuses a slot already recorded by
another managed target before it asks Docker to start a container. It also
refuses to mount a profile already consumed by any other container, including
a stopped or foreign container.

Profile creation is normally implicit. Use the profile commands to inspect or
manage the durable state directly:

```sh
agentbrowse profile create signed-in
agentbrowse profile list
agentbrowse profile list --json
agentbrowse profile delete signed-in
```

Deletion fails while any container still mounts the profile. It permanently
removes that profile's browser state and cannot be undone.

The command prints the target's configured network CDP endpoint. Use it directly
with `agent-browser`:

```sh
agent-browser --cdp http://BROWSER_HOST_ADDRESS:9223 open https://example.com
agent-browser --cdp http://BROWSER_HOST_ADDRESS:9223 snapshot -i
```

## Use agentbrowse as an agent-browser provider

Configure agent-browser to run the `agentbrowse provider` subcommand as a
`browser.provider` plugin. Add this entry to the `plugins` array in the
project's `agent-browser.json`, or in `~/.agent-browser/config.json` for global
use:

```json
{
  "plugins": [
    {
      "name": "remote-browser",
      "command": "agentbrowse",
      "args": ["provider"],
      "capabilities": ["browser.provider"]
    }
  ]
}
```

Launch an agent-browser session through the configured provider:

```sh
agent-browser --session research --provider remote-browser open https://example.com
agent-browser --session research --provider remote-browser snapshot -i
agent-browser --session research --provider remote-browser close
```

Resolve a running agent-browser session to the exact Browser target incarnation
that backs it. This is the safe identifier for Live View and Agentattention
handoffs; the stable session or profile name is not a substitute:

```sh
agentbrowse resolve research
agentbrowse resolve research --json
```

Set `AGENT_BROWSER_PROVIDER=remote-browser` to omit `--provider remote-browser`
from each command. The plugin name must match `provider.name` in the agentbrowse
config.

The provider maps the agent-browser session name to a stable Browser profile;
session names outside agentbrowse's name grammar receive a stable safe profile
name. A launch reuses the target currently bound to that profile or allocates
the first free slot and creates a uniquely named target incarnation. Close
always destroys that exact target, including one that was already running when
the provider received the launch request, while preserving the profile. A
later launch gets a new target name with the same cookies and authentication
state, so an old target reference cannot silently resolve to the replacement.

The fleet's `browser` skill composes this provider lifecycle with agent-browser's
version-matched command guide and Agentattention. A sign-in, MFA prompt, or
captcha is prepared in the agent's current session and handed to the human as
that exact live target; cookies written by the human remain in the Browser
profile for later target incarnations.

No provider server runs locally. agent-browser starts `agentbrowse provider`
for one `plugin.manifest`, `browser.launch`, or `browser.close` request; the
subcommand responds over standard output and exits. The agent-browser daemon
then connects directly to the returned network-reachable CDP URL.

For an editable fleet installation, run `scripts/install.sh --install`. It
installs frozen Bun dependencies, links `~/.local/bin/agentbrowse` to this
checkout, and records the deployed Git commit under
`~/.local/state/agentbrowse/deployed-sha`.

Delete only that exact, ownership-labeled container when finished. Its Browser
profile and pinned Kernel image are preserved:

```sh
agentbrowse destroy testing
```

Pass `--json` to the target or profile lifecycle commands for a stable
`{schema_version,ok,error,data}` envelope. With `images.sourceDirectory`
configured, the CLI selects the SHA-tagged image matching that checkout;
`images.defaultImage`, `--image`, or `AGENTBROWSE_IMAGE` selects an
already-loaded image explicitly.

## Native Live View

Open a provider-managed Browser target by its agent-browser session name:

```sh
agentbrowse view
```

`view` applies the provider's stable session-to-profile mapping, resolves the
profile's current Browser target, then owns the Live View SSH tunnel until the
GUI closes. The Browser target must already exist; create it first with an
agent-browser command such as `agent-browser open https://example.com`. Pass a
session name to both commands when using a session other than `default`.

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

## OpenTUI Live View

Build the headless dylib and run the reference app:

```sh
bun run native:build
bun run opentui:example
```

The app opens on a blank stage showing `no browser`. Press `ctrl+shift+b` to
open its Browser-target picker. Running targets are selectable; stopped targets
and slot conflicts remain visible with a disabled reason. Choosing a target
closes the picker, opens a managed SSH tunnel, and replaces the stage with the
live browser surface. `ctrl+c` exits and closes both the Live View session and
tunnel.

The reusable surface is independent of that picker:

```ts
import {
  listBrowserTargets,
  LiveViewRenderable,
  loadOpenTuiCore,
} from "agentbrowse/opentui";

const { createCliRenderer } = await loadOpenTuiCore();

const renderer = await createCliRenderer({ targetFps: 15, maxFps: 30 });
const liveView = new LiveViewRenderable(renderer, {
  width: "100%",
  height: "100%",
  pollFps: 15,
});
renderer.root.add(liveView);
renderer.start();

const target = (await listBrowserTargets()).find((candidate) => candidate.selectable);
if (target) {
  await liveView.connect(target);
  liveView.focus();
}

async function shutdown(): Promise<void> {
  await liveView.dispose();
  renderer.destroy();
}
```

`LiveViewRenderable` owns one headless native session and its SSH tunnel. It
uses OpenTUI's public `NativeImage`/`ImageRenderable` API, forwards
keyboard, pointer, scroll, and paste input, and releases held input on every
focus or lifecycle boundary. Hosts keep ownership of layout, command routing,
and Browser-target selection. See `examples/opentui-browser.ts` for the complete
fxnk Ramp picker and `docs/architecture.md` for the runtime and ownership
boundaries. `@opentui/core` is a peer dependency. Hosts should obtain it through
`loadOpenTuiCore()` so source-linked checkouts and installed packages both use
the adapter's exact renderable and native-image runtime.

On macOS arm64, this checkout pins OpenTUI's native package to the
`possibilities/opentui` `carry/kitty-image-replacement` build. OpenTUI 0.5.8
otherwise deletes the visible Kitty image before transmitting every video-frame
replacement, briefly exposing the terminal background. The carry build keeps a
stable image identity and replaces its pixels without that destructive delete.
Its repository, exact source commit, release asset, SHA-256, and Bun integrity
are recorded in `config/opentui-carry.json` and checked against both
`package.json` and `bun.lock` by the test suite.

Bun overrides belong to the installation root and are not inherited from a
dependency. An OpenTUI host that embeds `agentbrowse/opentui`, including fmx,
must repeat the `@opentui/core-darwin-arm64` override from this repository and
lock that resolution until an official OpenTUI release includes the fix. The
adapter remains on public OpenTUI APIs; the carry is a narrow native-renderer
package, not an agentbrowse-specific API fork.

The reference app uses the mutually exclusive fxnk design language, not
Signal Room. Its theme layer follows fx exactly: valid `FX_THEME`, one bounded
OSC 11 background query, `COLORFGBG`, then dark; it resolves before
`setupTerminal()` and the first application frame. Live CSI 997 notifications
trigger a DA1-fenced OSC 11 refresh and one complete fixed-token swap. Reuse
`resolveFxnkTheme`, `fxnkRamp`, and `FxnkThemeMonitor` from
`agentbrowse/opentui`; do not use a terminal-palette detector or derive colors
from host RGB. OpenTUI's independent capability handshake is not theme input.

The dylib at `zig-out/lib/libagentbrowse-live-view.dylib` expects the installed
`zig-out/Frameworks/LiveKitWebRTC.framework` sibling through its rpath. Keep
those together when embedding the surface in another OpenTUI app. The default
library path is relative to the agentbrowse checkout; packaged hosts can pass
an explicit `nativeLibraryPath` to `LiveViewRenderable`.

## Development target

- macOS 11.0 or newer; Apple silicon is the validated development host
- Zig 0.16.0
- Bun 1.3.14 or newer
- the pinned LiveKit libwebrtc XCFramework described in
  `docs/adr/0001-native-webrtc-stack.md`

```sh
zig build test
tools/fetch-webrtc
zig build
```

`zig build` produces `zig-out/bin/kernel-live-view` for command-line
integration, the headless Live View dylib and public header, and the
self-contained `zig-out/Kernel Live View.app` bundle.
`zig build run -- --connection-stdin` runs the bundled executable so its pinned
WebRTC framework is resolved exactly as it is in the packaged application. The
bundle and nested framework receive ad-hoc signatures for local execution; no
distribution identity or notarization credential is used.

For a configured browser target, the root helper passes the descriptor to that
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
