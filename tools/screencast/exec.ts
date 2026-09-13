import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, writeSync } from "node:fs";
import type { HypemanBackendConfig } from "../../config/deployment.ts";
import { FixedBridge, type Frame } from "./bridge.ts";

/** Hypeman's authenticated exec API carries only this lease's fixed-port byte stream.
 * Local-only first slice: no SSH credentials, inbound Mac listener or new guest identity.
 */
export class ExecPeer {
  private socket: WebSocket | undefined;
  private buffer = "";
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly events = new Set<string>();
  private lastPong = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private error: Error | undefined;
  private readonly bridge: FixedBridge;
  constructor(
    private readonly backend: HypemanBackendConfig,
    readonly instanceId: string,
    port: number,
    private readonly onFailure: (error: Error) => void = () => {},
    private readonly lifetimeSeconds = 300,
    private readonly beforeRpc: () => void = () => {},
  ) {
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 300 || lifetimeSeconds > 1200)
      throw new Error("exec lifetime must be 300..1200 seconds");
    if (backend.remoteHost !== null || new URL(backend.baseUrl).hostname !== "127.0.0.1")
      throw new Error("first slice requires local loopback Hypeman API");
    this.bridge = new FixedBridge(
      port,
      (frame) => this.send(frame),
      (error) => this.fail(error),
    );
  }
  async connect(): Promise<void> {
    const files = Object.fromEntries(
      ["peer.py", "recorder.py"].map((name) => [
        name,
        readFileSync(new URL(name, import.meta.url)).toString("base64"),
      ]),
    );
    const boot = `import tempfile,pathlib,base64,os,sys\np=pathlib.Path(tempfile.mkdtemp(prefix='agentbrowse-peer-'))\nf=${JSON.stringify(files)}\nfor n,b in f.items(): (p/n).write_bytes(base64.b64decode(b))\nos.execv(sys.executable,[sys.executable,'-u',str(p/'peer.py')])`;
    const socket = new WebSocket(
      `${this.backend.baseUrl.replace(/^http/, "ws")}/instances/${encodeURIComponent(this.instanceId)}/exec`,
      {
        headers: { Authorization: `Bearer ${readFileSync(this.backend.tokenFile, "utf8").trim()}` },
      },
    );
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () =>
      socket.send(
        JSON.stringify({
          command: ["python3", "-c", boot],
          tty: true,
          timeout: this.lifetimeSeconds,
          wait_for_agent: 3,
        }),
      );
    socket.onmessage = (event) => {
      try {
        if (typeof event.data === "string") {
          const status = JSON.parse(event.data) as { error?: string; exitCode?: number };
          if (status.error || (status.exitCode !== undefined && !this.closed))
            this.fail(new Error(`exec terminated: ${status.error ?? status.exitCode}`));
          return;
        }
        this.buffer += Buffer.from(event.data as ArrayBuffer).toString("utf8");
        while (true) {
          const index = this.buffer.indexOf("\n");
          if (index < 0) break;
          if (index > 65536) throw new Error("exec frame bound exceeded");
          const frame = JSON.parse(this.buffer.slice(0, index)) as Frame;
          this.buffer = this.buffer.slice(index + 1);
          this.receive(frame);
        }
        if (this.buffer.length > 65536) throw new Error("exec framing bound exceeded");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    socket.onerror = () => this.fail(new Error("exec transport failed"));
    socket.onclose = () => {
      if (!this.closed) this.fail(new Error("exec transport lost"));
    };
    await this.wait("hello", 8000);
    this.lastPong = Date.now(); // Startup is bounded separately from the established heartbeat.
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastPong > 3000) this.fail(new Error("guest heartbeat expired"));
      else this.send({ type: "ping" });
    }, 400);
  }
  private receive(frame: Frame): void {
    if (frame.type === "rpc") {
      const id = frame.request as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (frame.ok === true) pending.resolve(frame.result as Record<string, unknown>);
      else pending.reject(new Error(String(frame.error)));
    } else if (["open", "data", "ack", "eof", "close"].includes(frame.type))
      this.bridge.receive(frame);
    else if (frame.type === "pong") this.lastPong = Date.now();
    else if (["hello", "ready", "stopped"].includes(frame.type)) {
      this.events.add(frame.type);
      if (frame.type === "stopped" && !this.closed)
        this.fail(new Error(`guest stopped: ${frame.reason}`));
    } else throw new Error("unknown guest frame");
  }
  check(): void {
    if (this.error) throw this.error;
    if (this.closed) throw new Error("grant revoked");
  }
  private send(frame: Frame): void {
    if (this.closed) return;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 1024 * 1024) {
      this.fail(new Error("exec output unavailable or backpressured"));
      return;
    }
    socket.send(Buffer.from(`${JSON.stringify(frame)}\n`));
  }
  private async wait(event: string, timeout: number): Promise<void> {
    const deadline = Date.now() + timeout;
    while (!this.events.has(event)) {
      this.check();
      if (Date.now() > deadline) throw new Error(`${event} deadline exceeded`);
      await Bun.sleep(20);
    }
  }
  async grant(port: number): Promise<void> {
    this.send({ type: "grant", port });
    await this.wait("ready", 4000);
  }
  rpc(
    op: string,
    fields: Record<string, unknown> = {},
    timeout = 10000,
  ): Promise<Record<string, unknown>> {
    this.beforeRpc();
    this.check();
    const request = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request);
        reject(new Error(`${op} deadline exceeded`));
      }, timeout);
      this.pending.set(request, { resolve, reject, timer });
      this.send({ type: "rpc", request, op, ...fields });
    });
  }
  async copy(kind: "video" | "snapshot", path: string): Promise<{ size: number; sha256: string }> {
    const info = await this.rpc("info", { kind });
    const size = info.size as number;
    if (!Number.isSafeInteger(size) || size < 1 || size > 256 * 1024 * 1024)
      throw new Error("invalid artifact bound");
    const file = openSync(path, "wx", 0o600);
    const hash = createHash("sha256");
    const deadline = Date.now() + 60000;
    try {
      for (let offset = 0; offset < size; ) {
        if (Date.now() > deadline) throw new Error("copy deadline exceeded");
        const chunk = await this.rpc("read", { kind, offset });
        const data = Buffer.from(chunk.data as string, "base64");
        if (
          chunk.offset !== offset ||
          data.length < 1 ||
          data.length > 24576 ||
          offset + data.length > size
        )
          throw new Error("artifact chunk mismatch");
        let written = 0;
        while (written < data.length) written += writeSync(file, data, written);
        hash.update(data);
        offset += data.length;
      }
    } finally {
      closeSync(file);
    }
    const sha256 = hash.digest("hex");
    if (sha256 !== info.sha256) throw new Error("artifact hash mismatch");
    return { size, sha256 };
  }
  fail(error: Error): void {
    if (!this.error) {
      this.error = error;
      this.onFailure(error);
    }
    this.revoke();
  }
  revoke(): void {
    if (this.closed) return;
    // Destroy active host sockets before asking the peer to close its listener.
    this.bridge.revoke();
    this.closed = true;
    clearInterval(this.heartbeat);
    try {
      if (this.socket?.readyState === WebSocket.OPEN)
        this.socket.send(Buffer.from('{"type":"revoke"}\n'));
    } catch {
      /* EOF/heartbeat still revoke. */
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.error ?? new Error("grant revoked"));
    }
    this.pending.clear();
    // EOF is a second revocation mechanism; guest heartbeat is the crash backstop.
    this.socket?.close();
  }
}
