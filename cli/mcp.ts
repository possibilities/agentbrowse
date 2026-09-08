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
  let onEnd: () => void;
  const closed = new Promise<void>((resolve, reject) => {
    server.server.onclose = resolve;
    onEnd = () => {
      void server.close().catch(reject);
    };
  });
  // The SDK listens for data/errors but does not close its transport on EOF.
  // Install both close observers before connecting so an already-ended pipe
  // cannot leave the CLI awaiting a close event that will never arrive.
  process.stdin.once("end", onEnd!);
  try {
    await server.connect(new StdioServerTransport());
    if (process.stdin.readableEnded) onEnd!();
    await closed;
  } finally {
    process.stdin.off("end", onEnd!);
    await server.close();
  }
}
