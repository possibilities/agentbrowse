# Browser target lifecycle

An Ordered backend set contains Hypeman hosts. New profiles use the first
available host; only a classified failure before mutation permits fallback.
Authentication, image, capacity and ownership failures do not trigger fallback.
Once bound, a profile remains on its host until an explicit data migration.

A Browser target is one Hypeman VM. A Browser profile is a persistent ext4
volume attached to at most one VM. Backend-bound target receipts and profile
binding receipts route cleanup through the original host and exact incarnation.
Destroy preserves the profile; profile delete verifies ownership and refuses
volumes with any consumer, including stopped or foreign VMs.

The local service publishes CDP, Live View HTTP and WebRTC UDP on loopback.
The remote service maintains its own nftables forwards on Tailscale; Live View
HTTP travels through an SSH tunnel to the private guest. Slot-derived ports
include the configured port offset. No endpoints are published on public interfaces.

See [installation and migration](hypeman.md) and [configuration](configuration.md).
