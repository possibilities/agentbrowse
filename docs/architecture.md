# Architecture

agentbrowse has one platform-neutral Live View core and two frontend adapters.
The core owns signaling, WebRTC control state, input gating, reconnect policy,
decoded frames, and held-input cleanup. AppKit and OpenTUI decide only how to
present a frame and translate local input into that core.

## OpenTUI path

```text
BrowserTargetSource -> BrowserPickerController
                              |
                              v
                      selected Browser target
                              |
                   LiveViewTunnel (managed ssh -L)
                              |
                   connection descriptor bytes
                              |
OpenTUI <- NativeImage <- RGBA <- frame lease <- polling C ABI
   |                                                  |
   +---- keys / pointer / scroll / paste ------------>+
                                                      |
                                          Zig Live View session
                                                      |
                                  NSURLSession + LiveKitWebRTC
                                                      |
                                            Kernel/Neko target
```

`client/targets.ts` discovers Browser targets through the typed `BrowserFarm`
API rather than parsing CLI output. Running, conflict-free targets are
selectable. Stopped targets and slot conflicts remain visible with a disabled
reason. `BrowserPickerController` owns asynchronous discovery, selection, and
stale-result suppression; it has no rendering policy.

Selecting a target opens one `LiveViewTunnel`. The tunnel reserves an ephemeral
loopback port, starts an SSH local forward to the target's Live View HTTP port,
probes readiness, and owns the SSH child until disconnect. WebSocket signaling
uses that forward; WebRTC uses the target's configured network-reachable UDP candidate.
The connection descriptor is passed to native code as bounded bytes and is
never placed in argv or logs.

`NativeLiveViewSession` is the Bun wrapper around the versioned C ABI in
`include/agentbrowse_live_view.h`. The ABI deliberately has no callbacks into
JavaScript. Bun polls lifecycle and the newest frame from its own event-loop
thread, normally at 15 FPS, and sends input through synchronous session calls.
This keeps WebRTC and NSURLSession worker threads on the native side of the
runtime boundary.

`LiveViewRenderable` subclasses OpenTUI's public `ImageRenderable`; no OpenTUI
fork or native plugin is required. For each new generation it:

1. fits the rotated source aspect ratio to the available terminal cells using
   the terminal's measured pixel resolution when available;
2. asks native code to rotate, scale, and convert I420 directly into a bounded
   RGBA buffer;
3. hands the buffer to `NativeImage`, which `ImageRenderable` retains; and
4. releases the frame lease immediately.

The same fitted rectangle maps cell-center pointer coordinates back through
the inverse frame rotation. Keyboard events become X11 keysyms, including
Kitty press/release events and Unicode keysyms. Terminals that report only a
raw press are treated as taps so a key cannot remain held indefinitely.

The example host releases every held key and pointer button before its picker
opens. The adapter does the same when the renderable blurs, the terminal loses
focus, the target changes, transport disconnects, or teardown begins. Control
ownership remains a Live View session policy: the first attempted input
requests control when needed, and later input is gated until Neko authorizes
this client.

## Native frame ownership

The Objective-C++ bridge attaches two renderers to the WebRTC video track:

- LiveKitWebRTC's Metal view presents frames for the AppKit adapter.
- A raw renderer copies decoded I420 planes into an immutable, reference-counted
  `Frame` for every frontend-neutral consumer.

Publishing a frame assigns a monotonically increasing generation and replaces
the queue's one retained frame. A consumer acquires only a generation newer
than the one it has seen and receives an independent frame lease. Replacing or
clearing the queue cannot invalidate an outstanding lease, and releasing a
lease cannot affect the queue's reference. The queue therefore bounds pending
video memory to one frame plus leases currently held by consumers; it never
accumulates a playback backlog.

The native RGBA converter samples directly from the leased I420 planes. It has
no full-size intermediate, applies WebRTC rotation during sampling, uses BT.601
limited-range conversion, and caps output at 8192 pixels per dimension and 32
million pixels total.

## Threads and teardown

NSURLSession and WebRTC callbacks may enter Zig from worker threads. Session
state visible to polling clients is atomic or mutex-protected. Transport
objects, reconnect resets, sends, and delegate callbacks are serialized on the
native session monitor. Transport callbacks are counted by the Objective-C++
bridge, while the video sink has a separate lock covering the complete frame
callback. Destruction first stops transport work, disables new callbacks, and
waits for callbacks already inside Zig before any session-owned descriptor,
status, identifier, or frame queue is released.

OpenTUI target switching uses a separate operation generation. A tunnel or
session that completes after a newer connect, disconnect, or destroy operation
closes itself without publishing stale state. In-flight tunnel startup is also
abortable, and `dispose()` waits for that cancellation to reap its SSH child.
Normal teardown order is polling timer, Live View session, displayed image,
then SSH tunnel. `destroy()` remains safe for ordinary OpenTUI ownership
teardown.

## Frontend adapters

AppKit-specific behavior is confined to `src/platform/macos/appkit.zig` and the
AppKit half of `platform/macos/native_bridge.mm`: window and responder
lifecycle, native Metal presentation, macOS events, pasteboard access,
application shortcuts, and the transparent local cursor over the aspect-fitted
guest image. Creating a headless Live View session does not initialize
`NSApplication` or create a window.

OpenTUI-specific behavior is confined to `src/opentui` and `client`: target
discovery, the managed tunnel, Bun FFI, terminal image fitting, input mapping,
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

## Cursor limitation

The compatibility stream currently selected by Kernel's legacy proxy has the
guest cursor composited into the video. Hiding the macOS cursor over the fitted
AppKit image prevents a double cursor while interacting, but the last guest
cursor remains in the video after the macOS pointer leaves. Hover-only guest
cursor visibility requires consuming Neko's separate cursor metadata with its
pointerless stream and is a scoped follow-up rather than something either
frontend can remove from already-decoded pixels.
