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
Each directory has `manifest.json` and per-volume `metadata.json`, `verified.json`,
and `data.raw.zst`. Local binding copies are under
`~/.local/state/agentbrowse/archived-generated-bindings/BACKEND/` on the client.
These contain private browser state and are not committed.
