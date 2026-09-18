# Storage recovery and retention

The sustainable lifecycle is disposable task storage plus explicitly saved
profiles, described in [0015](adr/0015-explicit-profile-retention-and-session-leases.md).
The session registry caps unfinished disposable jobs at 16. Recovery is explicit:
inspect `session list`, establish that the task and human handoffs ended, and
release the exact lease. Keep saved profiles for intentional identities, normally
`personal`; do not create a saved profile for each task.

Hypeman's `/resources` disk allocation is a reservation count, not physical disk
usage. Compare it with `du` and `df` on the host. Raising overcommit does not fix
unbounded retention. A saved profile currently reserves its configured volume
size, normally 1 GiB; each active target additionally reserves a 10 GiB overlay.
Kernel's native profile archives remain available for explicit transfers.

## Historical generated-profile cleanup

`tools/archive-idle-profiles.py` inventories exact AgentBrowse-owned profiles
matching the former generated `agentscrape-PID-...` naming convention. It refuses
attached volumes, preserves metadata and the complete filesystem as a private
zstd backup, then decompresses and compares SHA-256 and logical size. It never
deletes volumes. Supply `--root`, `--helper`, `--backend` and `--destination`;
without `--apply` it only inventories. Run it on the owning host.

After backup completes, run:

```sh
bun tools/reclaim-archived-profiles.ts BACKEND ABSOLUTE_BACKUP_DIRECTORY
bun tools/reclaim-archived-profiles.ts BACKEND ABSOLUTE_BACKUP_DIRECTORY --apply
```

The first command validates without deleting. The second holds the provider's
local registry lock, checks exact volume ownership, attachment state and whether
source or backup changed, saves local binding receipts, and deletes through the
normal profile lifecycle. An attached or changed volume stops the operation.
Only run this maintenance for authorized cleanup. Generated names alone do not
prove browser contents are unimportant; the verified backups are retained.
Do not delete or overwrite those backups in routine cleanup.

Backups are **Hypeman filesystem recovery files**, not Kernel profile archives;
`profile import` must not receive `data.raw.zst`. Recovery requires restoring the
verified filesystem into a detached, separately created and ownership-checked
Hypeman volume, then using Kernel export/import if a logical profile transfer is
wanted. Preserve the backup and existing named profiles during recovery. Do not
restore old live target identities or merge Chromium files from different profiles.

The September 10, 2026 cleanup stores backups under
`profile-backups/2026-09-10-generated` inside each host's AgentBrowse Hypeman root.
The local `2026-09-10-generated-late` directory covers one additional detached
profile from the deployment window.
Each directory has `manifest.json` and per-volume `metadata.json`, `verified.json`,
and `data.raw.zst`. Local binding copies are under
`~/.local/state/agentbrowse/archived-generated-bindings/BACKEND/` on the client.
These contain private browser state and are not committed.

## Portable full-volume backup sets

Use the supported fleet command before allocating backup storage:

```sh
agentbrowse backup measure --all --compression-estimate --json
```

This is read-only. It reports every configured backend's exact profile count,
host metadata and local-binding reconciliation findings, reserved capacity, raw
logical size, physical allocation, and sampled zstd expectation and uncertainty.
Totals include both decimal and binary units.

Create or resume one set on the selected host after closing every profile target.
Paths name storage on that backend: local paths are on the Mac and remote paths are
on the remote host. Age authenticated encryption is the default.

```sh
agentbrowse backup create --backend artbird \
  --destination /mnt/private/profile-backups/2026-09-18 \
  --recipient age1example --dry-run
agentbrowse backup create --backend artbird \
  --destination /mnt/private/profile-backups/2026-09-18 \
  --recipient age1example
agentbrowse backup list --backend artbird --destination /mnt/private/profile-backups
agentbrowse backup inspect --backend artbird \
  --set /mnt/private/profile-backups/2026-09-18
```

Each profile image is compressed and encrypted independently. A set without
`manifest.json` is incomplete and safe to resume with the identical command.
The helper refuses attached, changed, inconsistent, or unclean filesystems.
Use `--unencrypted` only as an explicit decision to store authentication state in
compressed plaintext. The installer provides the established `age` tool; a missing
binary or recipient is a concrete failure and AgentBrowse never substitutes custom
cryptography.

Restore requires an empty destination namespace for every logical profile. It uses
new volume IDs, verifies each image before publication, and writes new local backend
bindings only after host success. The age identity path is on the destination host.

```sh
agentbrowse backup restore --backend local \
  --set /Volumes/Recovery/profile-backups/2026-09-18 \
  --identity /Volumes/Recovery/keys/profile-backup.agekey --dry-run
agentbrowse backup restore --backend local \
  --set /Volumes/Recovery/profile-backups/2026-09-18 \
  --identity /Volumes/Recovery/keys/profile-backup.agekey
```

The backup records only recovery metadata and complete volume images. Slots, target
and VM identities, session leases, credentials, SSH keys, and connection descriptors
are not copied or restored. After restore, launch each logical profile normally and
validate its browser state before retiring any source or backup media. The ownership
and transaction decision is recorded in [ADR 0018](adr/0018-portable-profile-volume-backups.md).
