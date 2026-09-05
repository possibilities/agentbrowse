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
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // connect() returns as soon as the transport is listening. The process stays
  // alive on stdin, and this resolves when the host closes it.
  //
  // The SDK's stdio transport watches stdin for `data` and `error` only, and
  // its error handler reports without closing. A host that closes the pipe
  // instead of signalling, or a pipe that fails, would otherwise leave this
  // process parked forever. End-of-input emits `end`; a failed stream emits
  // `error` then `close` and never `end`; either closes the transport once,
  // which is what fires `onclose`.
  await new Promise<void>((resolve) => {
    server.server.onclose = resolve;
    let closing = false;
    const closeTransport = () => {
      if (closing) return;
      closing = true;
      void transport.close();
    };
    process.stdin.once("end", closeTransport);
    process.stdin.once("close", closeTransport);
  });
}
