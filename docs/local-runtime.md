# Local Live View runtime

The root tool manages named Kernel/Neko containers on artbird without modifying
the `kernel-images` checkout. Each name maps to a numeric slot, which gives it a
unique loopback HTTP port and WebRTC UDP mux port.

```sh
tools/live-view start local 0
tools/live-view status local
```

Keep the HTTP/WebSocket tunnel open in another terminal:

```sh
tools/live-view tunnel local
```

Then launch the native app. The command emits the sensitive connection
descriptor into a pipe; it never appears in the process arguments:

```sh
tools/live-view launch local
```

Additional browsers use additional slots and separate app processes:

```sh
tools/live-view start testing 1
tools/live-view tunnel testing
tools/live-view launch testing
```

Each process creates its own outbound input channel. The deployed Neko server
also opens a same-labeled inbound channel; this is expected and the bridge
deliberately keeps the client-created channel for pointer and keyboard packets.

The container and image are preserved by `stop`. Tunnel lifecycle remains
external to the app, so closing the AppKit window never leaves an app-owned SSH
process behind.

`tools/live-view destroy NAME` removes only that named container and its
generated local target config; the pinned image remains available. This is
useful for deliberately transient diagnostic targets.

`start` validates an existing container's pinned image, WebRTC settings,
Tailnet-only UDP bind, and loopback-only HTTP bind before reusing it. It fails
closed on drift rather than silently running a target under different network
or media settings.

`AGENTBROWSE_NEKO_LOG_LEVEL=trace` can be supplied when creating a fresh named
target. Trace logs contain signaling material and must be treated as sensitive;
the default is `info`, and transient trace targets should be destroyed after
the diagnostic run.
