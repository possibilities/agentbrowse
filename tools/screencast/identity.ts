import type { Target } from "../../cli/model.ts";
import type { SessionReceipt } from "../../cli/sessions.ts";

/** Reject a stale lease, foreign owner, recycled target name or stopped VM. */
export function assertOwner(
  lease: SessionReceipt,
  current: SessionReceipt | undefined,
  target: Target,
  row: Record<string, unknown>,
  instanceId?: string,
): string {
  if (
    lease.persistent ||
    current?.persistent !== false ||
    current.session !== lease.session ||
    current.lease !== lease.lease ||
    current.profile !== lease.profile ||
    current.target?.name !== target.name ||
    current.target?.backend !== "local"
  )
    throw new Error("lease changed");
  const tags = row.tags as Record<string, string> | undefined;
  if (
    row.name !== target.container ||
    row.state !== "Running" ||
    (instanceId && row.id !== instanceId) ||
    tags?.["dev.agentbrowse.managed"] !== "true" ||
    tags["dev.agentbrowse.role"] !== "kernel-browser" ||
    tags["dev.agentbrowse.target"] !== target.name ||
    tags["dev.agentbrowse.profile"] !== lease.profile ||
    tags["dev.agentbrowse.backend"] !== "local"
  )
    throw new Error("target incarnation or owner changed");
  if (typeof row.id !== "string" || !row.id) throw new Error("missing instance UUID");
  return row.id;
}
