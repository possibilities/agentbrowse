import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HypemanBackendConfig } from "../../config/deployment.ts";
import { ExecPeer } from "./exec.ts";

test("guest startup does not consume established heartbeat budget; loss notifies owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "exec-heartbeat-"));
  const tokenFile = join(root, "token");
  writeFileSync(tokenFile, "fixture-only", { mode: 0o600 });
  let answer = true;
  let failure: Error | undefined;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      async message(ws, message) {
        const frame = JSON.parse(String(message));
        if (frame.command) {
          await Bun.sleep(3400);
          ws.send(Buffer.from('{"type":"hello"}\n'));
        } else if (frame.type === "ping" && answer) ws.send(Buffer.from('{"type":"pong"}\n'));
      },
    },
  });
  const peer = new ExecPeer(
    {
      remoteHost: null,
      baseUrl: `http://127.0.0.1:${server.port}`,
      tokenFile,
    } as HypemanBackendConfig,
    "fixture-immutable-id",
    54321,
    (error) => {
      failure = error;
    },
  );
  try {
    await peer.connect();
    await Bun.sleep(600);
    expect(() => peer.check()).not.toThrow();
    answer = false;
    const deadline = Date.now() + 4500;
    while (!failure && Date.now() < deadline) await Bun.sleep(50);
    expect(failure?.message).toBe("guest heartbeat expired");
    expect(() => peer.check()).toThrow("guest heartbeat expired");
  } finally {
    peer.revoke();
    server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
}, 12000);
