# Artbird browser runtime

The `agentbrowse` CLI manages named Kernel/Neko browser targets on Artbird
without modifying the `kernel-images` checkout. Each name maps to a numeric
slot, which gives it unique CDP, loopback HTTP, and WebRTC UDP ports.

```sh
agentbrowse create testing --slot 1
tools/live-view status testing
```

Slot 0 maps CDP to port 9222, Live View HTTP to 18080, and WebRTC UDP to
56000. Each additional slot increments all three ports. CDP and WebRTC bind
only to Artbird's Tailnet address; Live View HTTP binds only to Artbird
loopback.

The create result contains the CDP URL used by `agent-browser`:

```sh
agent-browser --cdp http://ARTBIRD_TAILNET_IP:9223 open https://example.com
```

Keep the HTTP/WebSocket tunnel open in another terminal:

```sh
tools/live-view tunnel testing
```

Then launch the native app. The command emits the sensitive connection
descriptor into a pipe; it never appears in the process arguments:

```sh
tools/live-view launch testing
```

Additional browsers use additional names, slots, and app processes:

```sh
agentbrowse create research --slot 2
tools/live-view tunnel research
tools/live-view launch research
```

Each process creates its own outbound input channel. The deployed Neko server
also opens a same-labeled inbound channel; this is expected and the bridge
deliberately keeps the client-created channel for pointer and keyboard packets.

Tunnel lifecycle remains external to the app, so closing the AppKit window
never leaves an app-owned SSH process behind.

`agentbrowse destroy NAME` removes only that named, ownership-verified
container and its generated local target metadata. The pinned image remains
available. `create` validates an existing container's image, labels, CDP,
WebRTC settings, Tailnet-only direct binds, and loopback-only HTTP bind before
reusing it. It fails closed on drift.

`AGENTBROWSE_NEKO_LOG_LEVEL=trace` can be supplied when creating a fresh
browser target. Trace logs contain signaling material and must be treated as
sensitive; the default is `info`, and transient trace targets should be
destroyed after the diagnostic run.
