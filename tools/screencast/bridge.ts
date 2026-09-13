import { createConnection, type Socket } from "node:net";

export type Frame = Record<string, unknown> & { type: string };
const CHUNK = 16384;
const LIMIT = 16;

/** One immutable loopback destination, owned by one authenticated exec channel.
 * The guest never supplies a host, port or credential. Revocation destroys existing sockets.
 */
export class FixedBridge {
  private readonly sockets = new Map<number, { socket: Socket; waiting: boolean }>();
  private stopped = false;
  constructor(
    readonly port: number,
    private readonly send: (frame: Frame) => void,
    private readonly fail: (error: Error) => void,
  ) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid port");
  }
  receive(frame: Frame): void {
    if (this.stopped) return;
    const id = frame.id;
    if (!Number.isSafeInteger(id) || (id as number) < 1) throw new Error("invalid stream identity");
    const key = id as number;
    if (frame.type === "open") {
      if (this.sockets.has(key) || this.sockets.size >= LIMIT)
        throw new Error("stream bound exceeded");
      const socket = createConnection({ host: "127.0.0.1", port: this.port });
      const state = { socket, waiting: false };
      this.sockets.set(key, state);
      const connectTimer = setTimeout(
        () => socket.destroy(new Error("loopback connect timeout")),
        2000,
      );
      let ackTimer: ReturnType<typeof setTimeout> | undefined;
      const pump = () => {
        if (state.waiting || this.stopped) return;
        const data = socket.read(Math.min(socket.readableLength, CHUNK)) as Buffer | null;
        if (!data) return;
        state.waiting = true;
        this.send({ type: "data", id, data: data.toString("base64") });
        ackTimer = setTimeout(() => this.fail(new Error("guest consumption timeout")), 3000);
      };
      socket.on("connect", () => {
        clearTimeout(connectTimer);
        this.send({ type: "ack", id });
      });
      socket.on("readable", pump);
      socket.on("end", () => this.send({ type: "eof", id }));
      socket.on("error", () => this.send({ type: "close", id }));
      socket.on("close", () => {
        clearTimeout(connectTimer);
        clearTimeout(ackTimer);
        this.sockets.delete(key);
        if (!this.stopped) this.send({ type: "close", id });
      });
      // Pump on acknowledgement without switching to unbounded flowing mode.
      socket.on("bridgeAck", () => {
        clearTimeout(ackTimer);
        state.waiting = false;
        pump();
      });
      return;
    }
    const state = this.sockets.get(key);
    if (!state) return;
    if (frame.type === "ack") state.socket.emit("bridgeAck");
    else if (frame.type === "data") {
      if (typeof frame.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data))
        throw new Error("invalid chunk");
      const data = Buffer.from(frame.data, "base64");
      if (data.length > CHUNK) throw new Error("chunk bound exceeded");
      state.socket.write(data, () => {
        if (!this.stopped) this.send({ type: "ack", id });
      });
    } else if (frame.type === "eof") state.socket.end();
    else if (frame.type === "close") state.socket.destroy();
    else throw new Error("unknown bridge frame");
  }
  revoke(): void {
    this.stopped = true;
    for (const state of this.sockets.values()) state.socket.destroy();
    this.sockets.clear();
  }
  get active(): number {
    return this.sockets.size;
  }
}
