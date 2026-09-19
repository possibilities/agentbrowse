# 0018: Back up complete detached profile volumes as versioned sets

AgentBrowse owns portable disaster recovery for the durable Hypeman volume beneath
each Browser profile. A Profile volume backup is a versioned directory whose images
are independently compressed and, by default, authenticated with age encryption.
The complete `manifest.json.age` is the publication point for the default encrypted
format; its authenticated ciphertext covers the recovery metadata and encryption
policy. Explicit plaintext sets instead publish `manifest.json` and require
`--allow-unencrypted` for inspection or restore. This makes a removed or replaced
encrypted manifest fail closed rather than silently downgrade to plaintext.
Per-profile receipts and a private operation-policy receipt make an interrupted set
resumable only with the same backend, profile inventory, recipients, and policy.
Because an age recipient is public and cannot authenticate who produced ciphertext,
create also returns the canonical manifest `setDigest`. Operators retain that digest
outside the backup destination and restore requires it. A replacement producer cannot
make a different manifest match that external anchor.

Backup accepts only exact AgentBrowse ownership metadata, an unattached volume, an
unchanged image fingerprint, and a clean read-only e2fsck result. The manifest keeps
the source backend, Hypeman/profile schema, logical profile and original volume
identity, capacity, hashes, and image size. It deliberately omits profile bindings,
targets, slots, session leases, connection descriptors, credentials, and SSH keys.
This format remains distinct from Kernel's native tar.zst Profile archive.

Before any host mutation, restore authenticates the manifest and reserves every
logical profile binding under the manifest digest. Restore creates an ignored
staging volume with a new Hypeman ID. It decrypts and
decompresses into a staging image, verifies its digest and filesystem, atomically
installs the image, then publishes only a fresh destination-backend profile name and
ownership tags. The client completes the reserved logical bindings after host success.
Existing destination profile names are refused. Durable restore receipts make that
sequence idempotent after interruption. An explicit reservation release first asks
the host to delete only incomplete, detached, exactly owned staging volumes; it
refuses a completed restore.

Encrypted images stream directly from zstd into age; no recoverable compressed
plaintext staging file exists. Opaque ordinal archive paths and minimized resume
receipts keep logical profile names, source volume identity, and recovery metadata
inside the encrypted manifest. Restore staging names and ownership tags derive from
the set digest and profile, so a retry reconciles a create that committed before its
response or receipt. The client records a set-digest-bound operation journal and
restore provenance on each binding, making partial multi-profile finalization
idempotent. Ordinary profile launch, export, import, and deletion refuse pending
restore bindings.

Provider session receipts also reserve logical profile names, including prepared
disposable sessions that do not yet have a profile binding. Restore takes the provider
session registry lock before the sorted profile-binding locks, rejects every held name,
and publishes its complete binding reservation before releasing the registry. Session
prepare, launch, and release use the same lock order. Cleanup from a legacy disposable
receipt additionally preserves any binding carrying restore provenance.

Host operations serialize per set or restore root, reject symlinks in privileged
path components, bound decrypted manifests and decompressed images, and keep zero
runs sparse where the filesystem supports holes. Capacity is limited by the signed
64-bit byte range consistently in configuration and recovery validation.
Dry-run decrypts, decompresses, hashes, and read-only-checks every image in temporary
storage before any destination volume or binding mutation.

Path checks reject observed symlink components and leaf symlinks, and sensitive file
creation uses exclusive/no-follow operations where available. A residual check/use
race remains if another privileged process can rename an ancestor directory between
validation and a later pathname operation. Backup destinations and Hypeman roots must
therefore remain exclusively administered while the serialized operation runs; an
unprivileged writer must not control any ancestor.

`agentbrowse backup measure --all --compression-estimate --json` is the read-only
capacity gate. It reconciles host API/disk metadata and local profile bindings and
reports reserved, logical, allocated, expected compressed, and uncertainty bytes in
decimal and binary units. Compression is a stratified zstd level-3 sample estimate;
its stated interval is planning evidence, not a promise about a completed archive.
