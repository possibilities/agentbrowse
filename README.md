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

The fleet installer owns `~/.config/agentbrowse/config.json`; for development,
copy [`config.example.json`](config.example.json) there and replace its example
deployment values. Its version 2 `backends` array is ordered: the Docker-backed
remote host is first and an already-enabled Apple `container` session is second.
Agentbrowse falls through only for classified host/service availability failures
while a profile has no backend home yet. It never starts Apple services, pulls or
builds an image, or publishes an Apple host port. `AGENTBROWSE_CONFIG` selects
another absolute path for isolated tests. Replace the documentation-only
`192.0.2.10` address and other placeholders before use. See
[`docs/configuration.md`](docs/configuration.md).

Browser profiles and Browser targets have separate lifetimes. A Browser profile
is a durable backend-owned volume containing Chromium cookies, local storage,
IndexedDB, and authentication state. A Browser target is one Kernel container
incarnation that mounts that profile. The profile stays bound to its home backend
after target deletion so a later launch cannot silently substitute a same-named,
empty volume elsewhere. Deleting a profile is always an explicit operation.

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

The list includes each target's profile and backend, plus stopped and
failed-created containers as well as running ones. A `!` beside the state means
more than one target records the same slot on that backend. `create` refuses a
slot already recorded by another managed target before it asks the selected
backend to start a container. It also refuses to mount a profile already
consumed by any other container, including a stopped or foreign container.
Apple is additionally bounded to one 2-CPU, 6-GiB target.

Profile creation is normally implicit. Use the profile commands to inspect or
manage the durable state directly:

```sh
agentbrowse profile create signed-in
agentbrowse profile list
agentbrowse profile list --json
agentbrowse profile delete signed-in
```

Deletion fails while any container still mounts the profile. It permanently
removes that profile's browser state and backend binding and cannot be undone.

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
      "name": "agentbrowse",
      "command": "agentbrowse",
      "args": ["provider"],
      "capabilities": ["browser.provider"]
    }
  ]
}
```

Launch an agent-browser session through the configured provider:

```sh
agent-browser --session research --provider agentbrowse open https://example.com
agent-browser --session research --provider agentbrowse snapshot -i
agent-browser --session research --provider agentbrowse close
```

Resolve a running agent-browser session to the exact Browser target incarnation
that backs it. This is the safe identifier for Live View and Agentattention
handoffs; the stable session or profile name is not a substitute:

```sh
agentbrowse resolve research
agentbrowse resolve research --json
```

Set `AGENT_BROWSER_PROVIDER=agentbrowse` to omit `--provider agentbrowse`
from each command. The plugin name must match `provider.name` in the agentbrowse
config.

The provider maps the agent-browser session name to a stable Browser profile;
session names outside agentbrowse's name grammar receive a stable safe profile
name. The first launch selects the first available backend, then durably binds
the profile to it. A launch reuses the target currently bound to that profile or
allocates the first free slot and creates a uniquely named target incarnation on
the same backend. Close always destroys that exact target, including one that
was already running when the provider received the launch request, while
preserving the profile and its backend home. A later launch gets a new target
name with the same cookies and authentication state, so an old target reference
cannot silently resolve to the replacement.

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
`{schema_version,ok,error,data}` envelope. By default the CLI selects the exact
`linux/amd64` platform digest in `config/kernel-headful.lock.json`;
`images.defaultImage`, `--image`, or `AGENTBROWSE_IMAGE` selects another
already-loaded image explicitly. Maintainers intentionally refresh the lock
with `bun run images:update-lock FULL_KERNEL_COMMIT`; ordinary installation and
browser launch never inspect the registry or mutate the lock.

## Native Live View

Open a provider-managed Browser target by its agent-browser session name:

```sh
agentbrowse view
```

`view` applies the provider's stable session-to-profile mapping, resolves the
profile's durable binding to its current exact Browser target, then owns the
backend-returned Live View access until the GUI closes. The Browser target must
already exist; create it first with an agent-browser command such as
`agent-browser open https://example.com`. Pass a session name to both commands
when using a session other than `default`.

The application receives one connection descriptor on standard input and
connects immediately. It deliberately has no connection chooser:

```sh
bun run native:build:app
tools/live-view launch testing
```

`launch` opens the target's access descriptor and closes it when the application
exits. Docker targets use a managed SSH forward; Apple targets connect directly
to their `192.168.64.x` address without spawning SSH.

For a descriptor supplied by another integration:

```sh
zig build run -Doptimize=ReleaseFast -- --connection-stdin <path/to/connection.json
```

Connection descriptors can contain credentials or signed URLs. Keep descriptor
files mode `0600`, never pass their contents on the command line, and do not
commit them. See `docs/connection-descriptor.md` and `docs/local-runtime.md`.
The observed signaling contract is in `docs/protocol.md`; reusable frontend
boundaries and initial measurements are in `docs/architecture.md` and
`docs/performance.md`.

Treat every backend network as trusted infrastructure. Docker Live View HTTP is
kept on the browser host's loopback interface and reached through the managed SSH
forward; Apple targets use Apple's private container bridge. CDP and WebRTC trust
the configured private network, and CDP has no additional Agentbrowse
authentication, so never expose either endpoint to an untrusted network. The
example `kernel`/`admin` Live View credentials are public upstream compatibility
defaults, not a security boundary.

## OpenTUI Live View

Build the headless dylib and run the reference app:

```sh
bun run native:build
bun run opentui:example
```

Both `native:build` and `native:build:app` produce ReleaseFast artifacts. Use
an explicit `-Doptimize=Debug` only for debugging or a named comparison build.

For before/after evaluation, keep complete builds under distinct Zig prefixes.
The same prefix selects the preserved AppKit bundle and OpenTUI dylib:

```sh
zig build -Doptimize=Debug -p zig-out/comparisons/00-baseline-debug
zig build -Doptimize=ReleaseFast -p zig-out/comparisons/01-release-fast
bun run agentbrowse list
LIVE_VIEW_TARGET=replace-with-a-running-target
AGENTBROWSE_LIVE_VIEW_PREFIX=zig-out/comparisons/00-baseline-debug \
  tools/live-view launch "$LIVE_VIEW_TARGET"
AGENTBROWSE_LIVE_VIEW_PREFIX=zig-out/comparisons/01-release-fast \
  tools/live-view launch "$LIVE_VIEW_TARGET"
AGENTBROWSE_LIVE_VIEW_PREFIX=zig-out/comparisons/00-baseline-debug \
  bun run opentui:example
AGENTBROWSE_LIVE_VIEW_PREFIX=zig-out/comparisons/01-release-fast \
  bun run opentui:example
```

`AGENTBROWSE_LIVE_VIEW_PREFIX` resolves relative to the current directory. Keep
each prefix intact: its dylib and applications load the sibling
`Frameworks/LiveKitWebRTC.framework`. Sequential comparisons give more reliable
latency and CPU results than running two WebRTC decoders and renderers at once.
Use the exact name printed by `agentbrowse list`; `testing` is not a reserved or
automatically created Browser target.

Measure Input-to-decoded latency against a running Browser target with the
headless ABI:

```sh
bun run live-view:latency native-feel-test
AGENTBROWSE_LIVE_VIEW_PREFIX=zig-out/comparisons/00-baseline-debug \
  bun run live-view:latency native-feel-test --scenario baseline-debug
```

The default run uses 60 measured trials plus five discarded warmups for each
key/pointer and typing-like/full-viewport case. It takes about six minutes because
each trial waits one second for encoder rate control to settle. Pass `--json`
for complete provenance and raw trial results. The command creates and closes
an exact temporary CDP tab; leave other browser automation idle on that target
while it runs. Normal cleanup restores the previously visible tab, and dropping
the Live View session releases Neko control. A forced process termination can
leave the temporary probe tab open for manual closure.

The app opens on a blank stage showing `no browser`. Press `ctrl+shift+b` to
open its Browser-target picker. Running targets are selectable; stopped targets
and slot conflicts remain visible with a disabled reason. Choosing a target
closes the picker, opens the backend-returned access, and replaces the stage with the
live browser surface. `ctrl+c` exits and closes both the Live View session and
access.

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

`LiveViewRenderable` owns one headless native session and its Live View access. It
uses OpenTUI's public `NativeImage`/`ImageRenderable` API, forwards
keyboard, pointer, scroll, and paste input, and releases held input on every
focus or lifecycle boundary. Hosts keep ownership of layout, command routing,
and Browser-target selection. See `examples/opentui-browser.ts` for the complete
fxnk Ramp picker and `docs/architecture.md` for the runtime and ownership
boundaries. `@opentui/core` is a peer dependency. Hosts should obtain it through
`loadOpenTuiCore()` so source-linked checkouts and installed packages both use
the adapter's exact renderable and native-image runtime.

Frame conversion defaults to one process-wide Bun Worker, leaving the host
event loop available for input and rendering while native code converts four
row partitions. `conversionMode: "synchronous"` retains the same-thread path for
diagnosis and before/after measurement; worker startup or dylib-probe failure
falls back there automatically. `bun run live-view:adapter NAME
--conversion-mode synchronous` and the default async run record both native
duration and main-thread round trip with exact build provenance.

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
