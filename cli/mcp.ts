/**
 * The transport. `agentbrowse mcp` calls this and does not return until the
 * host closes stdio.
 *
 * Nothing else may write to stdout while this is running: stdout is the
 * protocol channel. Every command's output goes back through the tool result
 * instead, which is why the server is reached from `main.ts`'s `run()` rather
 * than from anything that also prints.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAgentbrowseMcpServer, type ServerOptions } from "./mcp-server.ts";

export async function serveAgentbrowseMcp(options: ServerOptions): Promise<void> {
  const server = createAgentbrowseMcpServer(options);
  await server.connect(new StdioServerTransport());
  // connect() returns as soon as the transport is listening. The process stays
  // alive on stdin, and this resolves when the host closes it.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
  });
}
