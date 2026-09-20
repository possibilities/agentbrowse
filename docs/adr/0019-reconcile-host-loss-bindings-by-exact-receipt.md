# 0019: Reconcile host-loss bindings by exact receipt

A verified Profile volume backup can outlive its source host while the controller
still retains Profile binding receipts for the lost volumes. Restore may retire those
receipts only when an authenticated backup manifest proves the complete logical set
and the operator explicitly names the exact source backend. Ordinary restore keeps
its empty-namespace rule.

The restore dry-run accepts an explicit source backend and optional additional state
namespaces. It maps every manifest profile to exactly one namespace, refuses duplicate
bindings or a binding on another backend, and records the opened file's device, inode,
creation generation, change/modify generation, size and SHA-256 bytes for the exact
binding and any matching target receipt. Reads use no-follow file descriptors and
recheck the path against the opened identity. A target receipt must agree with the
binding's profile, backend, target name, container identity, and slot. Profiles without
a prior binding belong to the primary namespace. Bindings whose names are outside the
manifest are never candidates.

The host installer creates one private, stable Hypeman host identity in the state
root. A wipe and reinstall therefore creates a new identity while ordinary AgentBrowse
upgrades preserve it. The restore helper returns that destination identity during
inspect and requires the same identity on restore and release.

The canonical plan includes the set digest, source and destination backends,
destination host identity, runtime directory, state namespace paths, ownership,
receipt revisions, and observed target identity. Its `reconciliationDigest` is the
mutation fence. Apply requires that exact digest, rechecks the plan while holding every
namespace's provider-session registry lock and the sorted Profile binding locks, and
stops before host mutation on host replacement, receipt drift, or any session receipt
holding a manifest name.

Exact old receipts move into private per-set archives before digest-bound restore
reservations replace them. Immediately before each archive, the locked operation
reopens and rechecks the exact identity and bytes. A durable reconciliation journal is
written first and records the exact reservation receipt revisions, plus per-namespace
release intent and commit progress. Release holds the provider-session registries,
shared runtime allocation lock and every sorted profile lock through host cleanup and
local commit. A retry can finish a partially prepared namespace or a crash between
local deletion and progress publication without treating a fresh binding as prior
work. A retry accepts only the same plan, exact receipt lineage, destination backend,
namespace set, and runtime directory. A fully released plan is terminal; reusing its
digest cannot authorize another retirement. No stale target or binding is deleted
based on its filename, logical name, or byte equality alone.

After host restore succeeds, the client finalizes each namespace's owned subset with
the existing restore provenance and operation journal. This preserves the backup and
restore transaction in [0018](0018-portable-profile-volume-backups.md), keeps profiles
that originated in a separate demo namespace there, and does not restore target,
session, slot, credential, key, or connection state.
