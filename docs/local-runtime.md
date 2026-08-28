# Remote browser runtime

The `agentbrowse` CLI manages durable Browser profiles and named Kernel/Neko
Browser targets on a configured host without modifying the `kernel-images`
checkout. A Browser profile owns Chromium cookies, local storage, IndexedDB,
and authentication state. A Browser target is one container incarnation that
mounts exactly one profile and maps a numeric slot to unique CDP, loopback HTTP,
and WebRTC UDP ports.

```sh
agentbrowse create testing --slot 1
agentbrowse create one-run --profile signed-in --slot 2
agentbrowse list
agentbrowse profile list
tools/live-view status testing
```

Manual `create` defaults the profile name to the target name. Profile creation
is implicit, or can be requested ahead of time with
`agentbrowse profile create NAME`. The Docker volume is named
`agentbrowse-profile-NAME` and is mounted
writable at `/home/kernel/user-data`, where Kernel keeps Chromium state.
agentbrowse permits at most one container to consume a profile, including
stopped managed targets and foreign containers discovered through Docker.

Slot 0 maps CDP to port 9222, Live View HTTP to 18080, and WebRTC UDP to
56000. Each additional slot increments all three ports. CDP and WebRTC bind
only to the configured network address; Live View HTTP binds only to the
browser host's loopback interface.

The create result contains the CDP URL used by `agent-browser`:

```sh
agent-browser --cdp http://BROWSER_HOST_ADDRESS:9223 open https://example.com
```

The same runtime is available through the browser provider. Configure
agent-browser with a plugin whose name matches `provider.name`, whose command is `agentbrowse`, whose
arguments are `["provider"]`, and whose capability is `browser.provider`.
Then the agent-browser session identifies the durable Browser profile while
the provider owns each Browser target incarnation:

```sh
agent-browser --session research --provider remote-browser open https://example.com
agent-browser --session research --provider remote-browser close
```

`browser.launch` reuses the target currently bound to the session's profile or
allocates its first free slot and a unique target name. `browser.close`
destroys that exact target unconditionally and preserves the profile. A later
launch mounts the same profile into a newly named target, retaining
authentication while making references to the destroyed target unambiguously
stale. The provider is a short-lived standard-input/standard-output process,
not a server; CDP continues to flow directly between agent-browser and the
configured browser host.

Open that Browser target in the native GUI using the original agent-browser
session name:

```sh
agentbrowse view
```

`view` applies the provider's stable session-to-profile mapping, resolves the
profile's current Browser target, and owns the Live View SSH tunnel until the
GUI closes. It does not provision a target, so the agent-browser session must
already have launched one. With no session argument, it opens agent-browser's
`default` session; pass a name to open a different session.

Launch the native app. The command opens the HTTP/WebSocket tunnel, waits for
it to become ready, and emits the sensitive connection descriptor into a
pipe; the descriptor never appears in the process arguments:

```sh
tools/live-view launch testing
```

Additional browsers use additional names, slots, and app processes:

```sh
agentbrowse create research --slot 2
tools/live-view launch research
```

Each process creates its own outbound input channel. The deployed Neko server
also opens a same-labeled inbound channel; this is expected and the bridge
deliberately keeps the client-created channel for pointer and keyboard packets.

Tunnel lifecycle remains external to the app but is owned by the launcher.
Closing the AppKit window returns control to the launcher, which reaps its SSH
process.

`agentbrowse destroy NAME` removes only that named, ownership-verified
container and its generated local target metadata. Its Browser profile and the
pinned image remain available. `agentbrowse profile delete NAME` permanently
removes the durable browser state and refuses while any container still mounts
it. `create` validates an existing container's image, labels, profile mount,
CDP, WebRTC settings, configured-address direct binds, and loopback-only HTTP
bind before reusing it. It fails closed on drift.

`AGENTBROWSE_NEKO_LOG_LEVEL=trace` can be supplied when creating a fresh
browser target. Trace logs contain signaling material and must be treated as
sensitive; the default is `info`, and transient trace targets should be
destroyed after the diagnostic run.
