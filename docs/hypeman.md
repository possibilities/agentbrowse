# Hypeman browser backends and comparison demo

Agentbrowse supports Docker, Apple container, and Hypeman in the same ordered
backend configuration. Hypeman runs the pinned Kernel headful OCI image inside a
VM: Virtualization.framework with Rosetta on the Mac, Cloud Hypervisor on artbird.
Profiles remain bound to the backend that owns their cookies. Switching the
backend order does not migrate an existing profile.

## Run the prepared comparison

From this checkout:

```sh
bun tools/browser-demo.ts configure
bun tools/browser-demo.ts up hypeman-local
bun tools/browser-demo.ts view hypeman-local
```

The choices are `artbird-docker`, `apple-local`, `hypeman-artbird`, and
`hypeman-local`. `configure` writes separate files under
`~/.config/agentbrowse/demos/` and reads artbird's Hypeman token through SSH into a
mode-0600 local file. It does not change the normal backend order. The demo uses
separate durable binding state under `~/.local/state/agentbrowse-demo` and named
`demo-*` profiles. It opens a page with a text field and a working counter.

`check` verifies browser JavaScript, persists a cookie across target destruction
and recreation, and launches a second independent browser simultaneously. It
cleans up the second browser and leaves the first ready for `view`:

```sh
bun tools/browser-demo.ts check hypeman-local
bun tools/browser-demo.ts check hypeman-artbird
bun tools/browser-demo.ts check apple-local
bun tools/browser-demo.ts check artbird-docker
```

The demo explicitly allocates 2 CPUs and 3 GiB to Apple and Hypeman targets to
allow a two-browser test on this 16-GiB Mac. These are demo allocations, not Mac
limits. Docker currently allocates 8 GiB per target. All demo backends use the
shared capture settings; inspect the generated configuration before drawing
performance conclusions. Prefer running one comparison at a time.

Measure actual keyboard/pointer input to decoded WebRTC frames:

```sh
AGENTBROWSE_CONFIG="$HOME/.config/agentbrowse/demos/hypeman-local.json" \
  bun tools/live-view-latency.ts demo-hypeman-local \
  --samples 10 --warmup 2 --scenario hypeman-local --json
```

Change the configuration and target name together for another backend. Small
samples prove the transport works; they are not a stable performance benchmark.
`bun run native:build:app` builds both the native viewer and the headless library.

Remove only one demo's browsers and authentication state:

```sh
bun tools/browser-demo.ts down hypeman-local
```

## Infrastructure preparation

The `agentbrowse-infra` repository owns the Hypeman lifecycle helper. On the Mac:

```sh
brew install caddy e2fsprogs
agentbrowse-infra hypeman setup
agentbrowse-infra hypeman enable
agentbrowse-infra hypeman pull docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3
agentbrowse-infra hypeman status
```

Setup pins Hypeman 0.3.0 and verifies the platform archive SHA-256. It uses the
short owned root `~/.local/share/ab-hypeman` because macOS Unix socket paths have a
small length limit. Services are explicitly started with launchd. A system-Python
supervisor owns the API process and loopback relays for CDP, Live View HTTP, and
WebRTC UDP. The relay discovers exact, ownership-tagged instances through the
API, does not start VMs, and closes obsolete forwards on reconciliation.

Apple container reserves `192.168.64.0/24` on this Mac; VZ consequently uses
`192.168.65.0/24`. Setup detects the active Apple network when choosing its
initial subnet. A different vmnet environment can require an explicit
`setup --subnet CIDR`, followed by disable/enable and target recreation. Inspect
`ifconfig` to confirm the actual VZ gateway (bridge100 or bridge101). This runtime pins a release
that honors the configured subnet; do not upgrade it without repeating the
Mac coexistence check. Direct VM addresses are infrastructure details; clients
use loopback endpoints and do not require Local Network permission changes.

On artbird, the host repository owns installation and service configuration:

```sh
cd ~/code/artbird
.venv/bin/ansible-playbook ansible/playbooks/hypeman.yml
ssh artbird sudo -n agentbrowse-hypeman pull docker.io/onkernel/chromium-headful@sha256:da9ee68cb9d2de0b3c26885ff3bdcf04c944254a36eb127219028ac017ff56f3
```

That playbook installs the helper from the adjacent `agentbrowse-infra` checkout,
Linux image-conversion tools and the pinned server, then starts the service. The
existing artbird firewall admits API access only through its trusted interfaces.
Agentbrowse refreshes an owned nftables table through SSH after lifecycle changes.
CDP and UDP bind logically to artbird's Tailscale address; Live View HTTP is
forwarded by SSH directly to the VM. Hypeman ports have an offset of 2000 by
default so they can coexist with the original Docker browsers using the same slot.
Choose distinct offsets when configuring multiple Hypeman services on one host.

`agentbrowse-infra hypeman disable` stops owned instances and the local service
while preserving images, profiles and receipts. Foreign instances block shutdown.
On artbird, use `ssh artbird sudo -n agentbrowse-hypeman disable`.

## Configure a backend

Add either shape to the existing version-2 `backends` array:

```json
{
  "id": "hypeman-local",
  "type": "hypeman",
  "baseUrl": "http://127.0.0.1:4973",
  "tokenFile": "/Users/YOU/.local/share/ab-hypeman/token",
  "cpus": 2,
  "memory": "6G",
  "profileSizeGb": 10,
  "portOffset": 2000
}
```

For a remote server, use its private API URL and add `remoteHost` (SSH alias) and
`networkAddress` (private IPv4). `tokenFile` is always an absolute path on the
client. The API uses bearer authentication; token contents never belong in argv
or a checked-in configuration. Launch does not pull images, enable services,
change default Docker contexts, or move profiles between runtimes.

The same provider, `resolve`, profile commands, `view`, MCP tools, AppKit viewer,
and OpenTUI frontend work with Hypeman targets. API operations use immutable
instance/volume IDs for deletion and recheck ownership and incarnation before
removing resources. Capacity and authentication failures do not trigger fallback.

## Kernel image compatibility

Hypeman's guest init chroots into the OCI root. Chromium cannot create its user
namespace from there. The launch wrapper configures the image's bundled setuid
sandbox and its conventional `chrome-sandbox` path, preserving Chromium sandboxing.
It also restores root ownership of the setuid mount utility after macOS image
unpacking and mounts `/dev/shm` as tmpfs. Neko advertises the relay address while
using a per-slot UDP mux port. Alternate images must provide these same paths and
Kernel/Neko interfaces.

For an exact owned instance, troubleshooting can use the authenticated exec API:

```sh
AGENTBROWSE_CONFIG="$HOME/.config/agentbrowse/demos/hypeman-local.json" \
  bun tools/hypeman-exec.ts INSTANCE_NAME /bin/sh -c 'df -h /dev/shm; ps aux'
```

The Apple comparison uses the optional loopback TCP relay too. Before its first
launch (and after restarting its infrastructure), run
`agentbrowse-infra relay enable`. This keeps Bun CDP requests independent of
private-network access permissions; native WebRTC still reaches Apple's guest
address. `agentbrowse-infra stop` preserves Apple profiles and stops its relay.

The pinned Kernel wrapper checks for supervisor socket existence before issuing
its first service starts. Both local launch wrappers remove stale runtime
sockets before boot so stopping and starting the same VM does not skip those
services. Existing Apple targets created with the older wrapper must be destroyed
and recreated once; their profiles are preserved.

Run local runtime lifecycle operations sequentially. During validation, overlapping
shutdown/recreation of Apple and Hypeman caused macOS vmnet bridges to disappear.
Recovery is explicit: `agentbrowse-infra hypeman disable`,
`agentbrowse-infra stop`, `agentbrowse-infra enable`,
`agentbrowse-infra relay enable`, then `agentbrowse-infra hypeman enable`.
Restart the existing demo targets with `up`; their profiles survive. Concurrent
browsers within each runtime and leaving both local runtimes active are tested.
