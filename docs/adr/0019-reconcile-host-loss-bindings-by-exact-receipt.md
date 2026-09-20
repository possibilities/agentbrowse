# 0019: Reconcile host-loss bindings by exact receipt

A verified Profile volume backup can outlive its source host while the controller
still retains Profile binding receipts for the lost volumes. Restore may retire those
receipts only when an authenticated backup manifest proves the complete logical set
and the operator explicitly names the exact source backend. Ordinary restore keeps
its empty-namespace rule.

The restore dry-run accepts an explicit source backend and optional additional state
namespaces. It maps every manifest profile to exactly one namespace, refuses duplicate
bindings or a binding on another backend, and records SHA-256 revisions for the exact
binding and any matching target receipt. A target receipt must agree with the binding's
profile, backend, target name, container identity, and slot. Profiles without a prior
binding belong to the primary namespace. Bindings whose names are outside the manifest
are never candidates.

The canonical plan includes the set digest, source and destination backends, runtime
directory, state namespace paths, ownership, receipt revisions, and observed target
identity. Its `reconciliationDigest` is the mutation fence. Apply requires that exact
digest, rechecks the plan while holding every namespace's provider-session registry
lock and the sorted Profile binding locks, and stops before host mutation on drift or
any session receipt holding a manifest name.

Exact old receipts move into private per-set archives before digest-bound restore
reservations replace them. A durable reconciliation journal is written first and is
updated through reservation and explicit release. A retry accepts only the same plan,
archive bytes, destination backend, namespace set, and runtime directory. It resumes a
partially archived or reserved operation and treats a completed re-run as a no-op.
No stale target or binding is deleted based on its filename or logical name alone.

After host restore succeeds, the client finalizes each namespace's owned subset with
the existing restore provenance and operation journal. This preserves the backup and
restore transaction in [0018](0018-portable-profile-volume-backups.md), keeps profiles
that originated in a separate demo namespace there, and does not restore target,
session, slot, credential, key, or connection state.
