# Architecture

`src/protocol` and `src/session` own the reusable Live View contract. The
Objective-C++ bridge owns Cocoa and libwebrtc object lifetimes, but all control
policy, state, input gating, held-input cleanup, connection descriptors, and
the latest-frame queue remain in Zig.

The WebRTC video track has two renderers:

- LiveKitWebRTC's Metal view presents frames in the AppKit frontend.
- A raw renderer copies decoded I420 planes into one immutable retained frame.
  Publishing replaces and releases the previous pending frame, so backlog is
  bounded to one. Consumers call `Session.acquireLatestFrame`, own the returned
  frame lease, and release it explicitly. The built-in checksum sink exercises
  this route independently of the Metal view.

An OpenTUI adapter therefore does not import AppKit or Objective-C types. It
links the Zig core (or a future C wrapper around the same API), acquires the
latest I420 frame, scales/converts it to the terminal image target, and releases
the lease. OpenTUI mouse-cell coordinates first become a fitted pixel rectangle
and then use `coordinates.mapPoint`; translated events enter the public
`Session.movePointer`, `setPointerButton`, `scroll`, `setKey`, and `paste`
methods. Control request/release, reconnect, held-input cleanup, and metrics
stay on the same `Session`.

AppKit-specific behavior is confined to `platform/macos/native_bridge.mm`:
window and responder lifecycle, native Metal presentation, macOS event
delivery, the pasteboard, application shortcuts, and the transparent local
cursor over the aspect-fitted guest image.

The compatibility stream currently selected by Kernel's legacy proxy has the
guest cursor composited into the video. Hiding the macOS cursor over the fitted
image prevents a double cursor while interacting, but the last guest cursor
remains in the video after the macOS pointer leaves. Hover-only guest cursor
visibility requires consuming Neko's separate cursor metadata with its
pointerless stream and is a scoped follow-up rather than something AppKit can
remove from already-decoded pixels.
