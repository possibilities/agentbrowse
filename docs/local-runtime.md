# Browser backend runtime

`agentbrowse` manages durable Browser profiles and Kernel/Neko Browser targets
across the configured ordered backend set. The installed version 2 deployment
can keep an SSH-backed remote Docker engine first and an already-enabled Apple
`container` session second.

A Browser profile owns Chromium cookies, local storage, IndexedDB, and
authentication state in a labeled named volume. A Browser target is one
container incarnation that mounts exactly one profile writable at
`/home/kernel/user-data`. Agentbrowse permits at most one container to consume a
profile, including stopped managed targets and foreign containers found by the
backend.

```sh
agentbrowse create testing --slot 1
agentbrowse create one-run --profile signed-in --slot 2
agentbrowse list
agentbrowse profile list
tools/live-view status testing
```

Manual `create` defaults the profile name to the target name. Profile creation
is normally implicit, or can be requested with `agentbrowse profile create
NAME`. Every backend names the volume `agentbrowse-profile-NAME` and records
exact ownership, backend, profile, and schema labels.

## Backend selection and durable identity

The provider is short-lived and communicates over standard input/output. For a
profile with no home, it tries backends in order only while passive probes
report an unreachable host or unavailable service. Authentication, wrong
Docker identity, missing images, ownership drift, and capacity are terminal.
Any error after a successful probe is also terminal because mutation may have
started.

Before the selected backend's first mutation, Agentbrowse writes a versioned
profile binding under its state directory (`~/.local/state/agentbrowse` by
default). That receipt binds the profile to the backend that owns its cookies
and, while one exists, its current exact target. Reserving the home first keeps
an interrupted creation from retrying on another backend. Closing a target
clears only the current target identity; it deliberately preserves the backend
home. A later launch therefore cannot replace authenticated state with a
same-named empty volume elsewhere merely because backend availability changed.

Target receipts are versioned runtime records containing profile, backend,
exact container, target, and slot identity. Provider cleanup data carries the
same backend, exact target, and profile. A stale close clears the profile's
current-target binding only when its backend and target still match, so it
cannot detach a newer incarnation.

```sh
agent-browser --session research --provider agentbrowse open https://example.com
agentbrowse resolve research --json
agent-browser --session research --provider agentbrowse close
```

`browser.launch` reuses the target currently bound to the session's profile or
allocates a free slot and unique target name on the profile's home backend.
`browser.close` destroys that exact target and preserves the profile. A later
launch mounts the same profile into a newly named target, retaining
authentication while making references to the destroyed target unambiguously
stale.

## Ports and Live View access

Docker slots determine published CDP, loopback Live View HTTP, and WebRTC UDP
ports. Slot 0 maps them to 9222, 18080, and 56000; each additional slot
increments all three. CDP and WebRTC bind only to the configured network
address, while Live View HTTP binds only to the browser host's loopback
interface.

Apple targets expose the container's Direct `192.168.64.x` address instead:
CDP is port 9222, Live View HTTP is port 8080, and Neko's UDP mux is the
slot-derived port inside the container. Apple publishes no host ports and is
bounded to one 2-CPU, 6-GiB target.

These bindings assume trusted backend networking. Docker Live View HTTP is
reachable only through the managed SSH forward, and Apple targets use Apple's
private container bridge. CDP and WebRTC trust the configured private network;
CDP has no additional Agentbrowse authentication and must never face an
untrusted network. Live View's public upstream `kernel`/`admin` compatibility
defaults do not provide a security boundary.

Open the matching target in AppKit with the original agent-browser session
name, or name a target directly:

```sh
agentbrowse view research
tools/live-view launch testing
```

`view` resolves the profile binding's exact current target and does not
provision one. The launcher and OpenTUI adapter consume the same typed access
descriptor. Docker access owns an ephemeral SSH local forward; Apple access
uses the Direct base URL and owns no tunnel process. Connection credentials
flow through a bounded descriptor on standard input, never argv.

Each Live View process creates its own outbound input channel. Neko also opens
a same-labeled inbound channel; the bridge deliberately retains the
client-created channel for pointer and keyboard packets.

## Cleanup and Apple preparation

`agentbrowse destroy NAME` removes only the exact backend-bound target after
re-inspecting ownership, role, backend, target, profile, slot, and writable
mount identity. It preserves the Browser profile and image.
`agentbrowse profile delete NAME` permanently removes the durable browser state
and its backend binding, and refuses while any container still mounts it.

Apple preparation is always explicit:

```sh
agentbrowse-infra enable
agentbrowse-infra pull docker.io/onkernel/chromium-headful@sha256:...
# or: agentbrowse-infra load /path/to/locked-image.oci.tar
```

Agentbrowse never invokes those commands, `container system start`, an image
pull, or a builder. If Apple is stopped or the digest is absent, the error says
which manual command is required. `agentbrowse-infra disable` remains the only
supported cleanup for the owned local runtime and leaves Apple services
stopped.

`AGENTBROWSE_NEKO_LOG_LEVEL=trace` can be supplied when creating a fresh target.
Trace logs contain signaling material and must be treated as sensitive; the
default is `info`, and transient trace targets should be destroyed after the
diagnostic run.
