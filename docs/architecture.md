# Architecture

agentbrowse has one platform-neutral Live View core and two frontend adapters.
The core owns signaling, WebRTC control state, input gating, reconnect policy,
decoded frames, cursor observations, and held-input cleanup. AppKit and OpenTUI
decide only how to present those observations and translate local input into
that core.

AppKit key equivalents bypass the ordinary `keyDown:`/`keyUp:` responder pair.
The AppKit frontend forwards every focused Command chord except local paste and
quit, then lets the Zig adapter choose which browser conventions to translate.
One local monitor forwards and consumes every focused key-up. The monitor is
removed when the session closes, so releases arrive exactly once even when
Command went up first.

Both frontend adapters translate macOS browser conventions before admission:
Command-C/X/A/Z/L/T/W/R/F/N/P/D/+/−/0 become Control chords, Command-Left/Right
become Home/End, Command-Up/Down become Control-Home/End, and Option-Left/Right
become Control-Left/Right. Shift and unrelated physical modifiers are retained.
Each translated key uses only its own modifier transform, so a concurrently
held shortcut cannot turn an unrelated key into a Control chord. The effective
snapshot precedes the target key-down; an explicit key-up releases the target
before restoring the current physical snapshot. Shifted targets retain their
shifted keysym and XKB level instead of sending an unshifted symbol while Shift
is held. Ordinary Caps Lock text selects the guest level from the reported
character, while translated shortcuts follow physical Shift and ignore Caps
Lock. Physical-key targets are cleared with held input on blur, control loss,
reconnect, and teardown.
Command-V remains local paste and Command-Q remains local quit. Terminals
without explicit key-up reports send translated keys as taps and clear their
modifier snapshot immediately.

## OpenTUI path

OpenTUI can translate only key reports that the terminal passes through. A
terminal's own bindings win first: stock Ghostty consumes most macOS Command
shortcuts (including copy/paste, select-all, undo, tabs/windows, search, zoom,
and Command/Option-arrow editing) before OpenTUI can observe them. Unbind those
Ghostty actions when full guest-shortcut parity is desired. With the defaults,
unbound chords such as Command-L/R/X/P still reach the adapter; terminal-emitted
replacement text is forwarded as text and cannot be reconstructed as the
original physical chord.

```text
BrowserTargetSource -> BrowserPickerController
                              |
                              v
                      selected Browser target
                              |
               LiveView access (SSH forward or Direct URL)
                              |
                   connection descriptor bytes
                              |
OpenTUI <- NativeImage <- RGBA <- conversion Worker <- frame lease <- polling C ABI
   |                                                  |
   +---- keys / pointer / scroll / paste ------------>+
                                                      |
                                          Zig Live View session
                                                      |
                                  NSURLSession + LiveKitWebRTC
                                                      |
                                            Kernel/Neko target
```

`client/targets.ts` discovers Browser targets through the typed `BrowserFleet`
API rather than parsing CLI output. Running, conflict-free targets are
selectable. Stopped targets and slot conflicts remain visible with a disabled
reason. `BrowserPickerController` owns asynchronous discovery, selection, and
stale-result suppression; it has no rendering policy.

Selecting a target opens one `LiveViewTunnel` access object. Docker access
reserves an ephemeral loopback port, starts an SSH local forward, probes
readiness, and owns the child until disconnect. Apple access returns the
container's Direct `192.168.64.x:8080` URL and closes without owning a process.
WebRTC uses the backend-returned network-reachable UDP candidate in either mode.
The connection descriptor is passed to native code as bounded bytes and is
never placed in argv or logs.

`NativeLiveViewSession` is the Bun wrapper around the versioned C ABI in
`include/agentbrowse_live_view.h`. The ABI deliberately has no callbacks into
JavaScript. Bun polls lifecycle and the newest frame from its own event-loop
thread, normally at 15 FPS, and sends input through synchronous session calls.
This keeps WebRTC and NSURLSession worker threads on the native side of the
runtime boundary. The wrapper accepts preserved ABI version 2 comparison
libraries and reports their unavailable input telemetry as `null`; ABI version
3 adds the input metrics snapshot without changing the version-2 layouts.

`LiveViewRenderable` subclasses OpenTUI's public `ImageRenderable`; it requires
no private API or native plugin. For each new generation it:

1. fits the rotated source aspect ratio to the available terminal cells using
   the terminal's measured pixel resolution when available;
2. transfers the lease to one process-wide Bun Worker, which asks native code
   to rotate, scale, and convert I420 directly into a bounded shared RGBA
   buffer;
3. receives the completed buffer and immediately hands it to `NativeImage`,
   which synchronously copies and `ImageRenderable` retains; and
4. lets the Worker release the frame lease on every completion path.

The Worker serializes conversions across renderables because each native call
already fans out over four Zig row workers. A renderable admits only one job at
a time, so polling while busy neither acquires another lease nor advances its
submitted generation. The main thread validates the session operation, fitted
size, and output byte count before presentation; a reconnect or resize can
therefore discard a completed buffer without touching a closed session. Worker
startup and dylib loading are probed before lease transfer. If either fails,
the same frame is converted synchronously; an unexpected failure after transfer
uses a shared atomic ownership word to claim one main-thread backstop release,
then future frames use synchronous fallback. This remains ABI version 2/3
behavior: the Worker loads the same absolute dylib and needs no new native API.

The OpenTUI 0.5.8 native Kitty renderer does require one downstream correction
for continuously changing images. Its stock replacement path deletes the
current Kitty image, transmits the next pixels, then places the image again.
Ghostty can present the cleared cell background between those commands, which
makes a healthy video stream strobe black. The pinned
`possibilities/opentui` `carry/pixel-mouse-shared-memory` build (stacked on
`carry/kitty-image-replacement`) preserves the placement and image ID,
retransmits replacement pixels under that identity, and retains destructive
deletes for actual removal or protocol changes. The same build adds the Kitty
shared-memory transmit ring and the DECRPM-fenced pixel mouse mode. The source
commit and both release artifacts, `@opentui/core` and
`@opentui/core-darwin-arm64`, are fixed in `config/opentui-carry.json` together
with the expected native library digest.

This pin is dependency-root policy. agentbrowse applies it for its own example
and tests, but package-manager overrides do not propagate through a dependency.
Every embedding OpenTUI application must apply both package overrides at its
root until upstream OpenTUI ships the changes; pinning only the native package
leaves pixel input and shared-memory transmit dormant. The adapter contract
itself remains entirely on OpenTUI's public API, so removing the carry later is
a dependency change rather than an integration rewrite.

The same fitted rectangle maps cell-center pointer coordinates back through
the inverse frame rotation. Keyboard events become X11 keysyms, including
Kitty press/release events and Unicode keysyms. Terminals that report only a
raw press are treated as taps so a key cannot remain held indefinitely.

Neko's selected `main` stream contains no cursor. OpenTUI deliberately leaves
cursor presentation to the terminal host pointer and never composites the
cursor observation available since ABI version 2. This produces one pointer for
local interaction; movement by another control host is intentionally not
shown in the OpenTUI frontend adapter.

The example host releases every held key and pointer button before its picker
opens. The adapter does the same when the renderable blurs, the terminal loses
focus, the target changes, transport disconnects, or teardown begins. Control
ownership remains a Live View session policy. When Neko announces implicit
hosting, the core sends the triggering input immediately and requests ownership
alongside it. Every accepted event enters one 256-slot Input delivery queue and
one drainer preserves FIFO order across frontend and native callback threads.
With explicit hosting, that queue remains undeliverable and retains at most 32
semantic events for two seconds; identifying this session as host opens the same
queue rather than transferring events through a replay buffer. Adjacent motion
and compatible scroll events may coalesce; keys, buttons, paste, and incompatible
scroll remain ordering barriers. Repeated held-key downs are suppressed because
Neko rejects them and X provides autorepeat after the original down.

The drainer never holds the admission lock across a native call. A key or button
changes committed held state only after its ordered send succeeds, so a failed
down can be retried and a failed up stays eligible for focus/control cleanup.
Control, transport, and focus cancellation clear resident events and advance one
epoch without stopping an active drainer. If an old-epoch down reports success
after cancellation, the drainer sends one best-effort up while the same transport
is still open, then continues with any deliverable new-epoch input. In explicit
mode an up sent after control has already moved to another host can be ignored by
Neko; its ten-second stuck-input sweep remains the final server-side backstop.
An immediately regained implicit host can also race a canceller's committed-key
release burst against a new down for the same key; if the down reaches Neko
first, the later release leaves guest and committed local state divergent until
the next release cycle or that server sweep.

## Native frame ownership

The Objective-C++ bridge attaches two renderers to the WebRTC video track:

- LiveKitWebRTC's Metal view presents frames for the AppKit adapter.
- A frontend-neutral observer copies decoded I420 planes into an immutable,
  reference-counted `Frame` for headless/OpenTUI sessions. AppKit sessions keep
  the observer metadata-only: it publishes decoded dimensions for input mapping
  and metrics without calling `toI420` or copying planes that Metal already owns.

Publishing a headless frame assigns a monotonically increasing generation and replaces
the queue's one retained frame. A consumer acquires only a generation newer
than the one it has seen and receives an independent frame lease. Replacing or
clearing the queue cannot invalidate an outstanding lease, and releasing a
lease cannot affect the queue's reference. The queue therefore bounds pending
video memory to one frame plus leases currently held by consumers; it never
accumulates a playback backlog.

The native RGBA converter samples directly from the leased I420 planes. It has
no full-size intermediate, applies WebRTC rotation during sampling, uses
center-aligned bilinear filtering for resized luma and chroma, uses BT.601
limited-range conversion, and caps output at 8192 pixels per dimension and 32
million pixels total. Output never exceeds the decoded display dimensions:
when a Retina terminal has more backing pixels than the stream, Ghostty's
linear GPU texture sampler performs the final enlargement instead of receiving
CPU-manufactured pixels.
Its bounded horizontal sampling caches are thread-local rather than caller-stack
storage, so Bun-controlled Worker stack sizing is not part of the ABI contract.

## Cursor observation ownership

The client-created WebRTC channel labeled `data` remains the outbound input
channel. Neko opens another channel with the same label on a different SCTP
stream. The pinned Neko runtime has legacy compatibility enabled: after it
observes the client-created channel, its internal active-channel reference can
move from the server-created stream to the client-created stream. Cursor
packets can consequently arrive on either known channel. The native bridge
preserves both objects, accepts cursor observations from both, and still sends
little-endian input only on the client-created channel that the pinned runtime
handles.

The Live View session parses inbound position and PNG image packets into one
mutex-protected latest-value cursor observation. Image, position, and combined
generations change independently so a polling consumer can copy an image only
while its generation is still current. Images are capped at 1 MiB and 1024
pixels per dimension. Position is cleared on control-host changes and the
entire observation is reset when transport identity changes, closes, or fails.
Neko sends no visibility or stall marker, so a stationary position cannot be
distinguished from a stalled producer.

## Threads and teardown

NSURLSession and WebRTC callbacks may enter Zig from worker threads. Session
state visible to polling clients is atomic or mutex-protected. The native
session monitor protects transport identity and ownership. Offer/candidate
negotiation snapshots that identity under the monitor, invokes WebRTC outside
it, then revalidates the captured peer in each completion: WebRTC may
synchronously cross executors and re-enter a delegate, so holding the monitor
across negotiation would invert the lock against its signaling thread.
Reconnect resets are serialized separately. Teardown swaps transport objects
out under the monitor, then closes them outside it. Transport callbacks are
counted by the Objective-C++ bridge, while the video sink has a separate lock
covering the complete frame callback. Destruction disables new callbacks and
waits for callbacks already inside Zig before any session-owned descriptor,
status, identifier, or frame queue is released. The embeddable session layer
never writes diagnostics to stdout or stderr; hosts obtain status through the
polling ABI so retained terminal surfaces cannot be corrupted. Input admission
and held-state locks are released before native sends. The delayed paste-ready
callback carries no transport identity, so the bridge counts it as in flight
under the native session monitor and invokes Zig after releasing that monitor;
state and reconnect callbacks retain their monitor ordering.

OpenTUI target switching uses a separate operation generation. An access,
session, or completed conversion that belongs to an older connect, disconnect,
or destroy operation cannot publish stale state. In-flight SSH startup is also
abortable, and `dispose()` waits for that cancellation to reap its child.
Normal teardown order is polling timer, Live View session, outstanding frame
conversion, displayed image, then Live View access. A frame lease is independent
of session lifetime, so the Worker can release it after the session closes;
`dispose()` then gracefully closes the shared Worker client. `destroy()` remains
safe for ordinary OpenTUI ownership teardown.

## Frontend adapters

AppKit-specific behavior is confined to `src/platform/macos/appkit.zig` and the
AppKit half of `platform/macos/native_bridge.mm`: window and responder
lifecycle, native Metal presentation, macOS events, pasteboard access,
application shortcuts, and cursor presentation over the aspect-fitted guest
image. While this client controls input, the local pointer uses the current
metadata-derived `NSCursor`; otherwise it remains an ordinary arrow. If a
different control host moves the guest pointer while the local pointer is
outside the fitted video, AppKit draws the cursor observation as an overlay.
Creating a headless Live View session does not initialize `NSApplication` or
create a window.

OpenTUI-specific behavior is confined to `src/opentui` and `client`: target
discovery, managed Live View access, Bun FFI, terminal image fitting, input mapping,
and the fxnk Ramp and fx-faithful theme resolver used by the example picker.
The resolver chooses one complete fixed set before first paint and its live
monitor replaces that set atomically; neither samples nor derives a host
palette. The reusable renderable contains no picker or application chrome, so
an fmx-like host can compose it beside embedded Ghostty terminals and retain
ownership of layout and commands.

Both the command-line AppKit client and the dylib target deploy to macOS 11.0.
The dylib loads `LiveKitWebRTC.framework` from `zig-out/Frameworks` through an
`@loader_path/../Frameworks` rpath; `zig build live-view-lib` installs the
public header and ad-hoc-signs both the dylib and sibling framework. Zig 0.16
does not expose Darwin's exported-symbols-list option through its build API, so
the dylib link joins a normalized Zig archive and an Apple-clang bridge object
with Apple's linker. `platform/macos/live_view.exports` restricts the resulting
dynamic symbol table to the public `ab_live_view_*` ABI.

## Cursor presentation

The Live View core authenticates against Neko's current API and requests its
pointerless `main` stream, rather than Kernel's legacy compatibility stream
whose `legacy` selector burns a cursor into every decoded frame. Cursor image
and position remain frontend-neutral observations in the session and polling
ABI. AppKit uses them to preserve guest cursor shape and shared-control
visibility; OpenTUI applies its host-pointer-only policy above. Agentattention
embeds the OpenTUI adapter and needs no cursor-specific behavior.
