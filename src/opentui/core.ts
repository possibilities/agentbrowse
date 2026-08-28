/**
 * Load the exact OpenTUI runtime used by Agentbrowse's frontend adapter.
 *
 * Source-linked consumers can otherwise resolve the peer dependency from a
 * different checkout, producing incompatible Renderable class identities.
 */
export async function loadOpenTuiCore(): Promise<typeof import("@opentui/core")> {
  return await import("@opentui/core");
}
