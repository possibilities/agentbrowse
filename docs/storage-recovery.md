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
  --recipient age1example --json
agentbrowse backup list --backend artbird --destination /mnt/private/profile-backups
agentbrowse backup inspect --backend artbird \
  --set /mnt/private/profile-backups/2026-09-18 \
  --identity /mnt/private/keys/profile-backup.agekey \
  --expected-set-digest RETAINED_SHA256
```

One Hypeman root can carry profiles for multiple exact backend IDs. Measure and
create one set per backend; a valid attached profile owned by another backend does
not block the selected set, while the selected backend's profiles must still be
detached. Malformed ownership and any repeated logical profile name across backends
remain blocking reconciliation findings. A single dated Greybird bundle is a parent
directory containing independent sets:

```text
/Volumes/scratch/agentbrowse-profile-backups/2026-09-19/
  artbird/
  hypeman-artbird/
```

Run each create with a configuration that explicitly declares the matching backend
ID and stage the child set first on the source host. After its manifest is published,
copy the complete child into a private `.incoming` directory on Greybird, inspect it
there with its separately retained `setDigest`, then rename that child into the layout
above. Retain both digests outside the parent. The parent is a transport bundle, not
a third manifest or a merged profile set.

If the remote service predates `profile-backup.py`, use the non-installing runner:

```sh
scripts/run-profile-backup-helper --remote artbird --backend artbird -- \
  create --destination /var/lib/agentbrowse-hypeman/profile-backups/2026-09-19/artbird \
  --recipient age1example --dry-run
```

Each profile image is compressed and encrypted independently. Encrypted sets publish
their authenticated policy and recovery metadata as `manifest.json.age`; plaintext
sets publish `manifest.json`. A set without either manifest is incomplete and safe
to resume with the identical backend, inventory, and recipients.
The helper refuses attached, changed, inconsistent, or unclean filesystems.
Use `--unencrypted` only as an explicit decision to store authentication state in
compressed plaintext. The installer provides the established `age` tool; a missing
binary or recipient is a concrete failure and AgentBrowse never substitutes custom
cryptography. Inspecting or restoring a plaintext set additionally requires
`--allow-unencrypted`, so loss or substitution of an encrypted manifest cannot
silently downgrade recovery.
The successful create result includes `setDigest`. Store that digest in a separate
operator record, password manager, or other trusted location outside the backup set.
Age recipients are public, so ciphertext authentication alone does not establish the
producer. Restore requires the separately retained digest.

Encrypted archives stream directly from zstd into age. The outer directory uses
opaque archive ordinals and minimized resume receipts; logical names, original volume
IDs, source metadata, and recovery policy remain in the encrypted manifest. Existing
nonempty destinations without AgentBrowse's exact private state receipt are refused.

Restore ordinarily requires an empty destination namespace for every logical profile.
It uses new volume IDs, verifies each image before publication, and writes new local
backend bindings only after host success. Before the host creates a volume, the client
reserves every logical name under the authenticated set digest. The age identity path
is on the destination host, and dry-run validates it and the encrypted manifest.
Prepared or active provider sessions also hold their profile names, even when a
disposable session has not created its profile volume yet. Close or release those
sessions before restoring a set containing the same names.

```sh
agentbrowse backup restore --backend local \
  --set /Volumes/Recovery/profile-backups/2026-09-18 \
  --identity /Volumes/Recovery/keys/profile-backup.agekey \
  --expected-set-digest RETAINED_SHA256 --dry-run
agentbrowse backup restore --backend local \
  --set /Volumes/Recovery/profile-backups/2026-09-18 \
  --identity /Volumes/Recovery/keys/profile-backup.agekey \
  --expected-set-digest RETAINED_SHA256
```

After a verified host replacement, old client binding receipts may still name the
source backend even though its profile volumes no longer exist. Reconcile those
receipts only through the restore dry-run. Name every state namespace that owns part
of the set; the first is `AGENTBROWSE_STATE_DIR`, and additional namespaces are
explicit absolute paths:

```sh
agentbrowse backup restore --backend artbird \
  --set /recovery/artbird --identity /recovery/profile-backup.agekey \
  --expected-set-digest RETAINED_SHA256 --reconcile-from-backend artbird \
  --binding-state-dir "$HOME/.local/state/agentbrowse-demo" --dry-run --json
```

Review `bindingReconciliation` in the result. It assigns every manifest profile to
exactly one namespace, shows the exact opened binding and target-receipt file identities
and byte revisions, confirms the authenticated source and selected destination
backends, records the installer-created identity of the rebuilt destination host, and
returns a `reconciliationDigest`. Applying requires the identical command without
`--dry-run` and with `--expected-reconciliation-digest REVIEWED_SHA256`. A different
destination host, a binding on another backend, a second binding for the same profile,
a changed receipt, or any provider session holding a manifest name stops before host
mutation.

If an interrupted reconciliation predates the destination-host fence, the next dry-run
validates its original journal and returns a new review digest that includes the
currently observed Hypeman host identity. The dry-run leaves the legacy journal
unchanged. Use only that new reviewed digest for retry or
`--release-reservations`; the old digest cannot authorize the newly identified host.

The apply step archives exact old binding and target receipts under each namespace's
`retired-bindings/restore-reconciliations/SET_DIGEST/`, publishes digest-bound restore
reservations, and keeps a private reconciliation journal. It never selects or removes
a receipt by name or bytes alone. Interrupted work retries with the same set and
reviewed digest; completed restore retries are no-ops. Release records intent before
host cleanup and commits each namespace durably while all session, runtime allocation,
and profile locks remain held. A fully released reconciliation is terminal and cannot
retire a later binding, even if that binding has byte-identical content. Profiles with
no prior binding are assigned to the primary namespace, while profiles found in an
additional namespace remain owned there. Unrelated bindings are not part of the plan
and remain untouched.

Retry the same command after interruption. To abandon an incomplete restore, use the
same set and identity with `--release-reservations`; the host first removes only
detached staging volumes whose ownership and receipt still match, then the client
releases the logical-name reservations. Completed restores cannot be released.
For a reconciled restore, retain the same source backend, additional state namespaces,
and reviewed reconciliation digest on the release command; the receipt archives and
reconciliation journal remain as history.
Dry-run performs complete decryption, zstd, digest, and read-only filesystem checks
without creating destination volumes or local binding reservations.

The backup records only recovery metadata and complete volume images. Slots, target
and VM identities, session leases, credentials, SSH keys, and connection descriptors
are not copied or restored. After restore, launch each logical profile normally and
validate its browser state before retiring any source or backup media. The backup
transaction is recorded in [ADR 0018](adr/0018-portable-profile-volume-backups.md),
and host-loss binding reconciliation is recorded in
[ADR 0019](adr/0019-reconcile-host-loss-bindings-by-exact-receipt.md).
