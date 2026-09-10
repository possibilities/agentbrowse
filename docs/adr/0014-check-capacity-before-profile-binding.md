# 0014: Check disk capacity before binding a new profile

For create and provider launch, inspect a candidate backend for the profile
before binding it. If it is absent, Hypeman's read-only `/resources` response
must have room for the configured profile volume plus the pinned runtime's
10 GiB default writable overlay. A classified capacity refusal permits trying
the next backend before any binding or volume creation. Malformed responses
and other errors surface immediately.

A reachable but full Artbird host otherwise captured each new profile's home,
created its volume, and rejected its target. Retrying could neither launch
there nor use the prepared local backend, while failed attempts consumed more
profile reservations.

This extends selection in [0006](0006-bind-browser-profiles-to-one-backend.md).
Existing bindings and existing volumes retain their home. Capacity checks do
not affect listing, target reuse, or cleanup. A race after preflight still
surfaces on the selected backend: the check reserves nothing and never permits
fallback after possible mutation. It does not delete profiles or repair a full
host; saved profiles there still require capacity recovery or explicit transfer.
