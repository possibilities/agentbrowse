# 0017: Synchronize local forwarding at lifecycle boundaries

The macOS Hypeman host hydrates its loopback forwarding once when the service
starts, then refreshes it only after an AgentBrowse-owned Browser target create,
start, or delete succeeds. Installer recovery performs the same refresh once
after restarting its preserved pre-install target set. The lifecycle command asks
the running supervisor over an owner-only Unix socket and waits for an explicit
success response. A failed refresh closes the relay's forwarding set and fails
the lifecycle command clearly, so a partial or stale set is never reported as
synchronized.

The relay previously requested Hypeman's complete instance list once per second,
even when no Browser target changed. Hypeman 0.3.0 derives live VZ state during
that request with a fresh HTTP transport and retains the resulting control-socket
keep-alive. One continuously running target therefore accumulated one paired Unix
descriptor about every five seconds until the host file table was exhausted.
Forwarding configuration changes only with the lifecycle operations AgentBrowse
already owns, so a timer was the wrong ownership boundary.

There is deliberately no periodic reconciliation fallback on macOS. Service
startup restores forwarding after host or service recovery, and every completed
AgentBrowse lifecycle mutation performs an acknowledged refresh. If the client
process dies after Hypeman accepts a mutation but before the refresh, the private
`~/.local/share/ab-hypeman/host/agentbrowse-hypeman network-sync` command repairs
forwarding explicitly, and the
next owned lifecycle transition also rebuilds the complete set. This bounds crash
recovery without recreating an idle discovery loop. Linux retains its existing
state reconciliation because its nftables forwarding and hypervisor transport are
different; remote AgentBrowse lifecycle commands already invoke `network-sync`.

This is a downstream containment measure for the pinned Hypeman release. It does
not replace correcting Hypeman's VZ client connection ownership, and removing it
later would require another explicit forwarding-owner decision rather than merely
updating the Hypeman pin.
