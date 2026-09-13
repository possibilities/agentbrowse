import { afterEach, expect, test } from "bun:test";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { FixedBridge, type Frame } from "./bridge.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const number = (server.address() as { port: number }).port;
  await new Promise<void>((r) => server.close(() => r()));
  return number;
}
async function start(destination: number, guestPort: number, heartbeat = true) {
  const child = Bun.spawn(["python3", new URL("./peer.py", import.meta.url).pathname], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const messages: Frame[] = [];
  let error: Error | undefined;
  const send = (frame: Frame) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    child.stdin.flush();
  };
  const bridge = new FixedBridge(destination, send, (e) => {
    error = e;
    bridge.revoke();
  });
  const reading = (async () => {
    const reader = child.stdout.getReader();
    let pending = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += Buffer.from(value).toString();
      while (true) {
        const index = pending.indexOf("\n");
        if (index < 0) break;
        const m = JSON.parse(pending.slice(0, index)) as Frame;
        pending = pending.slice(index + 1);
        messages.push(m);
        if (["open", "data", "ack", "eof", "close"].includes(m.type)) bridge.receive(m);
      }
    }
  })();
  const ping = heartbeat ? setInterval(() => send({ type: "ping" }), 400) : undefined;
  cleanups.push(async () => {
    clearInterval(ping);
    bridge.revoke();
    child.kill();
    await child.exited;
    await reading;
  });
  send({ type: "grant", port: guestPort });
  for (let i = 0; i < 100 && !messages.some((m) => ["ready", "stopped"].includes(m.type)); i++)
    await Bun.sleep(20);
  return { child, messages, send, bridge, reading, failure: () => error };
}
async function server(handler: (socket: Socket) => void): Promise<Server> {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    s.close();
  });
  return s;
}
function number(s: Server): number {
  return (s.address() as { port: number }).port;
}
async function connect(p: number) {
  const s = createConnection({ host: "127.0.0.1", port: p });
  cleanups.push(() => {
    s.destroy();
  });
  await new Promise<void>((r, reject) => {
    s.once("connect", r);
    s.once("error", reject);
  });
  return s;
}
test("real subprocess pipes preserve HTTP Host and Origin bytes", async () => {
  const received: Buffer[] = [];
  const s = await server((c) =>
    c.on("data", (b) => {
      received.push(Buffer.from(b));
      c.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nOK");
    }),
  );
  const p = await port();
  const peer = await start(number(s), p);
  const c = await connect(p);
  let response = "";
  c.on("data", (b) => {
    response += b;
  });
  c.write(
    "POST /write HTTP/1.1\r\nHost: 127.0.0.1:4317\r\nOrigin: http://127.0.0.1:4317\r\nContent-Length: 0\r\n\r\n",
  );
  await new Promise<void>((r) => c.once("end", r));
  expect(response).toContain("200 OK");
  expect(Buffer.concat(received).toString()).toContain("Origin: http://127.0.0.1:4317");
  expect(peer.failure()).toBeUndefined();
}, 8000);
test("revocation closes existing TCP streams as well as the listener", async () => {
  const sockets: Socket[] = [];
  const s = await server((c) => sockets.push(c));
  cleanups.push(() => {
    for (const c of sockets) c.destroy();
  });
  const p = await port();
  const peer = await start(number(s), p);
  const c = await connect(p);
  c.write("held request");
  await Bun.sleep(100);
  const ended = new Promise<void>((r) => c.once("close", r));
  peer.bridge.revoke();
  peer.send({ type: "revoke" });
  await ended;
  await peer.child.exited;
  await peer.reading;
  expect(peer.bridge.active).toBe(0);
  expect(peer.messages.some((m) => m.type === "stopped")).toBe(true);
  await expect(connect(p)).rejects.toThrow();
}, 8000);
test("owner EOF and missed heartbeat reclaim guest listener", async () => {
  const p = await port();
  const peer = await start(await port(), p, false);
  await peer.child.exited;
  expect(peer.messages.some((m) => m.reason === "heartbeat_expired")).toBe(true);
  await expect(connect(p)).rejects.toThrow();
  const q = await port();
  const eof = await start(await port(), q, false);
  eof.child.stdin.end();
  await eof.child.exited;
  expect(eof.messages.some((m) => m.reason === "owner_eof")).toBe(true);
  await expect(connect(q)).rejects.toThrow();
}, 8000);
test("occupied guest port fails without replacement or fallback", async () => {
  const s = await server((c) => c.end("original"));
  const peer = await start(await port(), number(s), false);
  expect(await peer.child.exited).toBe(1);
  expect(peer.messages.some((m) => m.type === "ready")).toBe(false);
  const c = await connect(number(s));
  expect(await new Promise<string>((r) => c.once("data", (b) => r(b.toString())))).toBe("original");
}, 5000);

test("two independent grants cannot select each other's fixed service", async () => {
  const a = await server((c) => c.on("data", () => c.end("service-a")));
  const b = await server((c) => c.on("data", () => c.end("service-b")));
  const pa = await port(),
    pb = await port();
  await start(number(a), pa);
  await start(number(b), pb);
  for (const [p, expected] of [
    [pa, "service-a"],
    [pb, "service-b"],
  ] as const) {
    const c = await connect(p);
    c.write("CONNECT unrelated-host:9999\r\n");
    expect(await new Promise<string>((r) => c.once("data", (data) => r(data.toString())))).toBe(
      expected,
    );
  }
}, 8000);

test("acknowledged chunks preserve two MiB through real TCP and subprocess pipes", async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 0xab);
  const s = await server((c) => c.on("data", () => c.end(payload)));
  const p = await port();
  await start(number(s), p);
  const c = await connect(p);
  const chunks: Buffer[] = [];
  c.on("data", (data) => chunks.push(Buffer.from(data)));
  c.write("request");
  await new Promise<void>((r) => c.once("end", r));
  expect(Buffer.concat(chunks).equals(payload)).toBe(true);
}, 12000);

test("real stdout pipe backpressure exits within the finite drain deadline", async () => {
  const script = `import subprocess,threading,time,json
p=subprocess.Popen(['python3',${JSON.stringify(new URL("./peer.py", import.meta.url).pathname)}],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def feed():
 try:p.stdin.write(b'{"type":"ping"}\\n'*100000);p.stdin.flush()
 except BrokenPipeError:pass
thread=threading.Thread(target=feed,daemon=True);thread.start();start=time.monotonic()
try:
 code=p.wait(timeout=7)
 print(json.dumps({'code':code,'seconds':time.monotonic()-start,'buffered':len(p.stdout.read())}))
finally:
 if p.poll() is None:p.kill();p.wait()
 thread.join(2)
`;
  const child = Bun.spawn(["python3", "-c", script], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  expect(await child.exited).toBe(0);
  const result = JSON.parse(output);
  expect(result.code).toBe(1);
  expect(result.seconds).toBeLessThan(7);
  expect(result.buffered).toBeGreaterThan(0);
}, 10000);
