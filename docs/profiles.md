# Browser profiles and Kernel

The live Browser profile is a Hypeman volume. Kernel writes Chromium's files
under `/home/kernel/user-data`; Agentbrowse mounts the volume at `/home/kernel`
so Kernel can prepare and atomically replace `user-data` through `/configure`.
Hypeman 0.3.0 enforces exclusive writable attachment, including against foreign
instances. Agentbrowse's ownership checks and allocation lock provide routing,
actionable errors, and serialized target/slot allocation on this machine.

Profile bindings retain the backend home because an unavailable host must not
silently become an empty profile on another host. Stable agent-browser session
names, `resolve`, and Agentattention's exact target names retain their existing
contracts. Agentattention's `agentbrowse/opentui` dependency and Agentscrape's
session selection require no changes. Agentbrain inherits that same session
through Agentscrape; AgentStart continues to own host selection and installation.

## Native archive transfer

Close the profile's current agent-browser session before transferring it:

```sh
agent-browser --session research close
agentbrowse profile export research /private/tmp/research.tar.zst --json
agentbrowse profile import research-copy /private/tmp/research.tar.zst --backend local --json
agent-browser --session research-copy open https://example.com
```

The export uses a temporary Browser target, closes Chromium through its native
CDP `Browser.close`, confirms a successful exit through Kernel's `/process/exec`
and supervisor state, syncs the filesystem, and streams
`GET /fs/download_dir_zstd?path=/home/kernel/user-data`. Files are published only
after download completes, with mode `0600`, and an existing destination is never
overwritten. Archives contain authentication state. They contain the directory's
contents directly, without an Agentbrowse format, path prefix, or JSON wrapper.

Import creates a new profile and gives `profile_archive` to Kernel's native
`POST /configure`. Kernel handles staging, extraction, ownership, replacement,
and one stop/apply/start cycle. No `start_url` is supplied, so Kernel does not
strip saved tabs. The temporary target is closed and removed before success;
the imported profile remains on the selected backend. The source file is retained.
Export and import are available through the generated MCP tools as well.

An import reservation is recorded before any backend mutation. Failed or
interrupted imports cannot launch through the provider, `create`, or `resolve`.
The incomplete profile and any target that could not safely close remain
inspectable. Destroy its temporary target if one remains, then repeat the same
import command with the intended archive to finish, or explicitly delete the
new profile. Imports never overwrite a previously ready profile.

## Existing volumes and shutdown

Existing running targets remain usable at their old mount path. On the next
fresh target, before Kernel starts, Agentbrowse relocates the old volume's root
entries into `user-data` using same-filesystem renames. A durable journal records
the entries before the first move; restarting after interruption resumes the
relocation. File bytes, permissions, hidden entries, and symlinks are preserved.
Conflicting or missing files stop startup instead of overwriting or initializing
empty state. No image rebuild, profile renaming, or reauthentication is required.

Normal destroy and provider close use Chromium's native CDP `Browser.close`,
wait for supervisor to confirm a successful exit, then sync guest filesystem
buffers before deleting the exact Hypeman instance. Signalling the process
alone does not reliably flush the newest localStorage writes. New targets use
supervisor's `autorestart=unexpected` and `exitcodes=0`, so a graceful close does
not start another writer; crashes still restart. An explicit launch can start
a cleanly exited Chromium through Kernel without replacing the VM. The fallback
supervisor stop policy uses `TERM` with 30 seconds rather than immediate `KILL`.
Kernel's launcher continues to run Chromium as the unprivileged `kernel` user.
If graceful close or sync fails, the VM and profile are retained for retry.
`agentbrowse destroy TARGET --force` explicitly skips that step for an
unresponsive VM and can lose unflushed writes. An already stopped VM can be
removed without contacting its absent API.

On macOS, run `scripts/install-host` when upgrading to install the native API's
loopback relay at `28080 + slot + portOffset`. The installer preserves VM and
volume IDs but interrupts running browsers while refreshing the host service.
Linux uses a temporary SSH tunnel to the guest API on port 10001; no additional
public listener or host update is required for this change.

The layout change is forward-only. Once a volume has been relocated, it must
not be launched with the former Agentbrowse build that mounts its root directly
as `user-data`.

## Source evidence

Verified against the image pinned in `config/kernel-headful.lock.json`, Kernel
commit `57858c774681c646c238043d5cb75a9ff61797c6`:

- `server/cmd/api/api/chromium_configure.go`: preparation and sibling-directory replacement.
- `server/openapi.yaml`: `/configure`, `/process/exec`, and `/fs/download_dir_zstd`.
- `server/e2e/e2e_zip_transfer_bench_test.go`: stopping Chromium before archiving.
- `images/chromium-headful/supervisor/services/chromium.conf`: original shutdown policy.
- Hypeman tag `v0.3.0`, `lib/volumes/manager.go`: exclusive attachment under a native volume lock.

Kernel Images is not a hosted Kernel profile registry. Its native primitives
do not supply a durable cross-host profile name, backend selection, or the
exact target incarnation required by a human handoff. Agentbrowse retains
those responsibilities without parsing Chromium databases or implementing an
archive extractor.

## Verification

`bun tools/profile-smoke.ts local` and `bun tools/profile-smoke.ts artbird` use
unique synthetic profiles to exercise the real legacy mount and shutdown policy,
relocation, graceful close/reopen, explicit relaunch within a VM, native export,
and native configure import. They verify cookies, localStorage, and IndexedDB
and remove their own VMs, volumes, and archives. Run these sequentially because
they share the deployment's allocation lock. Unit checks cover interrupted
relocation, ownership, concurrent import reservations, failed close/sync, private
archive publication, CLI/MCP contracts, and private transport readiness.
