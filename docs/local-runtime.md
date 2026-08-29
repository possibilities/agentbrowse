# Browser backend runtime

`agentbrowse` manages Kernel/Neko Browser targets across the configured ordered
backend set. The installed version 2 configuration keeps Artbird's SSH-backed
Docker engine first and an already-enabled Apple `container` session second.

```sh
agentbrowse create testing --slot 1
agentbrowse list
tools/live-view status testing
```

Docker slots determine published CDP, loopback Live View HTTP, and WebRTC UDP
ports. Apple targets expose the container's Direct `192.168.64.x` address
instead: CDP is port 9222, Live View HTTP is port 8080, and Neko's UDP mux is
the slot-derived port inside the container. Apple publishes no host ports.

The provider is short-lived and communicates over standard input/output. It
tries backends in order only while availability probes report an unreachable
host or unavailable service. Authentication, wrong Docker identity, missing
images, drift, and capacity are terminal. After launch, provider cleanup data
contains both the backend id and Browser target name, so close routes directly
to the original backend even if order or availability changes.

```sh
agent-browser --session research --provider agentbrowse open https://example.com
agent-browser --session research --provider agentbrowse close
```

Open the matching target in AppKit with `agentbrowse view`, or name it directly:

```sh
tools/live-view launch testing
```

The launcher and OpenTUI adapter consume the same typed access descriptor.
Docker access owns an ephemeral SSH local forward; Apple access uses the Direct
base URL and its close operation owns no process. Connection credentials flow
through a bounded descriptor on standard input, never argv.

`agentbrowse destroy NAME` removes only the exact backend-bound target after
re-inspecting all ownership, role, backend, target, and slot labels. It keeps
the image. Apple container names include a unique generation suffix and the
exact generated name is stored in the version 2 target receipt.

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
