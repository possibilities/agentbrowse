# 0015: Make retention explicit and lease saved profiles

New driver sessions use disposable profiles. Provider close removes their exact
VM, volume and binding, after normal shutdown succeeds. Saved profiles require
`session prepare SESSION --profile NAME`; `personal` is the ordinary shared
identity. Each task keeps its own driver session. A durable, incarnation-specific
lease serializes access to a saved profile; close releases it while preserving
browser data. Different tasks never concurrently write or drive that profile.

Previously every fresh Agentscrape request became a permanent profile. Closing
its VM retained a reserved filesystem indefinitely. A driver session name now
identifies work, not an implicit promise to preserve authentication. Existing
profile bindings and volumes remain saved during the transition; their storage
cannot be reclassified as disposable based on their names alone.

The provider records ownership before backend mutation. Failed launches and
shutdowns remain visible in `session list` and recoverable with `session release
SESSION --lease LEASE`. Releases cannot affect a replacement lease. At most 16
unfinished disposable sessions may exist. There is no age-based lease stealing:
a human handoff can outlive its producer, and age does not establish abandonment.
An abandoned lease may block capacity until its owner or operator recovers it.
The registry lock serializes lifecycle operations on this machine; the contract
does not claim coordination between independently configured client machines.

This narrows [0006](0006-bind-browser-profiles-to-one-backend.md)'s retention
promise to saved profiles and extends [0014](0014-check-capacity-before-profile-binding.md)'s
capacity check with a bound on abandoned disposable work. Exact target ownership
from [0004](0004-separate-browser-profile-target-and-live-view-lifetimes.md) remains.

Saved profiles continue using [0013](0013-use-kernel-native-profile-lifecycle.md)'s
durable volumes and native Kernel import/export. One intentional profile costs
one configured volume reservation. Automatic cold archiving is deferred until
needed; it would require verified atomic publication and retention of a live
copy on export failure. Chromium profile merging is not supported. Sign-ins
from existing separate profiles must be re-established in `personal` or the
original saved profile used explicitly.
