# 0018: Back up complete detached profile volumes as versioned sets

AgentBrowse owns portable disaster recovery for the durable Hypeman volume beneath
each Browser profile. A Profile volume backup is a versioned directory whose images
are independently compressed and, by default, authenticated with age encryption.
The complete `manifest.json` is the publication point. Per-profile receipts make an
interrupted set resumable without replacing a verified archive.

Backup accepts only exact AgentBrowse ownership metadata, an unattached volume, an
unchanged image fingerprint, and a clean read-only e2fsck result. The manifest keeps
the source backend, Hypeman/profile schema, logical profile and original volume
identity, capacity, hashes, and image size. It deliberately omits profile bindings,
targets, slots, session leases, connection descriptors, credentials, and SSH keys.
This format remains distinct from Kernel's native tar.zst Profile archive.

Restore creates an ignored staging volume with a new Hypeman ID. It decrypts and
decompresses into a staging image, verifies its digest and filesystem, atomically
installs the image, then publishes only a fresh destination-backend profile name and
ownership tags. The client writes a new logical profile binding after host success.
Existing destination profile names are refused. Durable restore receipts make that
sequence idempotent after interruption.

`agentbrowse backup measure --all --compression-estimate --json` is the read-only
capacity gate. It reconciles host API/disk metadata and local profile bindings and
reports reserved, logical, allocated, expected compressed, and uncertainty bytes in
decimal and binary units. Compression is a stratified zstd level-3 sample estimate;
its stated interval is planning evidence, not a promise about a completed archive.
