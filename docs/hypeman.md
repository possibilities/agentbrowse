# Hypeman host installation

AgentBrowse uses Hypeman 0.3.0 on Apple silicon (Virtualization.framework and
Rosetta) and Linux x86_64 (Cloud Hypervisor). No Docker engine or CLI is required.
The browser and generic builder are pulled as published, digest-pinned OCI images.
The registry hostname `docker.io` does not imply a Docker runtime dependency.

## Install and operate

From the AgentBrowse checkout:

```sh
scripts/install.sh --install
scripts/install-host
scripts/install-host --remote artbird
```

The Mac requires Homebrew; the installer acquires missing caddy/e2fsprogs.
The Linux host requires working SSH, passwordless sudo for installation and
lifecycle, Debian APT, Tailscale and hardware virtualization (`/dev/kvm`).
Artbird provides generic host setup; AgentBrowse owns these workload prerequisites.
The installer stages Linux code into a root-owned directory before execution.

Installation preserves the existing Hypeman data roots, credentials, VM IDs
and volumes. Reinstallation detects changed helper bytes, stops owned VMs,
replaces the service, and restarts those same VMs. Foreign VMs block replacement.
Unchanged installations leave running VMs alone. Private client connection
files are written under `~/.config/agentbrowse/hosts/`; tracked backend policy
references them with `connectionFile`.

The Mac helper lives at `~/.local/share/ab-hypeman/host/agentbrowse-hypeman`.
The Linux helper is `/usr/local/bin/agentbrowse-hypeman`, linked to root-owned
`/usr/local/lib/agentbrowse/agentbrowse-hypeman`. Both support `setup`, `enable`,
`disable`, `status`, `pull IMAGE` and an authenticated `api` operation. `status`
can include connection details; do not publish raw output. Browser launch never
starts infrastructure or pulls images.

The host uses bounded 2x sparse-disk reservation overcommit; memory is not
overcommitted. New profiles default to 1 GiB (configurable); migrated Apple
filesystems retain enough space for their existing inode tables. Source images
are retained. Compaction operates only on detached migration-owned volumes and
checks the resized filesystem before replacement.

Mac launchd service `io.arthack.agentbrowse.serve-hypeman` starts at user login
and restarts after failure. Linux `agentbrowse-hypeman.service` is enabled at
boot with automatic restart. `disable` preserves all volumes and stops owned
VMs. On Linux the supervisor refreshes owned Tailscale CDP/WebRTC forwards when
VM addresses change; Mac uses a bounded loopback TCP/UDP relay. Remote Live View
HTTP uses SSH directly to the private VM. Keep these networks private.

The host installer pins a prebuilt generic builder in `build.builder_image`;
this bypasses Hypeman's default embedded Dockerfile bootstrap. Source-build
features are outside AgentBrowse's browser acceptance tests.

## Migrate existing profiles

Run host installation first, then the explicit transfer on each source host:

```sh
python3 host/migrate-profiles.py --backend local
ssh artbird sudo -n python3 /usr/local/lib/agentbrowse/migrate-profiles.py --backend artbird
python3 host/migrate-profiles.py --backend local --compact
ssh artbird sudo -n python3 /usr/local/lib/agentbrowse/migrate-profiles.py --backend artbird --compact
scripts/install-host
scripts/install-host --remote artbird
scripts/migrate-profile-bindings
scripts/migrate-profile-bindings --apply
```

Migration validates all source ownership tags before stopping source browsers.
It retains source storage and records each exact destination volume in a
private `migration/` receipt. It refuses attached or unreceipted destination
volumes. Docker directories become ext4 volumes verified with a read-only mount
and file comparison. Apple ext4 images are cloned, compared by sparse extents,
and checked with e2fsck before installation. The final compaction reduces
declared disk reservations; rerun the host installer afterward to refresh
Hypeman resource accounting. Completed receipts permit a safe
rerun without overwriting destinations subsequently used by a browser.

The client binding migration clears old target identities and moves verified
Apple profile homes to `local`; changing backend order alone never migrates data.
Use `--backend local` or `--backend artbird` to rebind one host independently.
Old bindings and target records are archived under
`~/.local/state/agentbrowse/retired-bindings`; bindings with previously absent
source storage are reported explicitly.
Retire Docker only after successful browser acceptance using Artbird's explicit
`ansible/playbooks/retire-docker.yml`. It retains original volume data. Funk's
explicit `libexec/retire-browser-runtimes` removes its old Docker CLI packages;
Apple's package removal requires its administrator uninstaller with `-k` to
retain data. The separate agentbrowse-infra project is retired after service
ownership and commands have moved. No cleanup removes authenticated source data.

## Browser acceptance

```sh
bun tools/browser-demo.ts configure
bun tools/browser-demo.ts check hypeman-artbird
bun tools/browser-demo.ts check hypeman-local
bun tools/browser-demo.ts view hypeman-local
```

`check` uses dedicated demo profiles, verifies browser JavaScript, a cookie
across target destruction/recreation, and two concurrent browsers. It removes
the second target/profile and leaves the first available for native viewing.
`down` deletes only that demo's targets and profiles. Native input/video probes
use `tools/live-view-latency.ts` with the matching demo configuration.

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
