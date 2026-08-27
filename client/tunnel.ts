import { createServer } from "node:net";
import type { BrowserListEntry } from "../cli/farm.ts";
import { targetFor } from "../cli/model.ts";
import { loadAgentbrowseConfig, requireConfigured } from "../config/deployment.ts";

const STDERR_LIMIT = 8 * 1024;
const READY_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 1_000;

interface TunnelProcess {
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly stderr: ReadableStream<Uint8Array>;
  kill(signal?: number): void;
}

export interface TunnelDependencies {
  allocatePort(): Promise<number>;
  spawn(args: readonly string[]): TunnelProcess;
  probe(url: string, signal?: AbortSignal): Promise<boolean>;
  sleep(milliseconds: number): Promise<void>;
  now(): number;
}

export interface TunnelOptions {
  remoteHost?: string;
  readyTimeoutMs?: number;
  /** Cancels tunnel startup. An already returned tunnel remains caller-owned. */
  signal?: AbortSignal;
  dependencies?: Partial<TunnelDependencies>;
}

const defaults: TunnelDependencies = {
  allocatePort: allocateLoopbackPort,
  spawn: (args) =>
    Bun.spawn([...args], {
      env: process.env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    }) as unknown as TunnelProcess,
  probe: async (url, signal) => {
    try {
      const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
      const response = await fetch(url, {
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      await response.body?.cancel();
      return response.ok;
    } catch {
      signal?.throwIfAborted();
      return false;
    }
  },
  sleep: (milliseconds) => Bun.sleep(milliseconds),
  now: () => Date.now(),
};

export class LiveViewTunnel {
  readonly baseUrl: string;

  private closePromise: Promise<void> | null = null;
  private stderrText = "";

  private constructor(
    readonly localPort: number,
    readonly target: Pick<BrowserListEntry, "name" | "slot">,
    private readonly process: TunnelProcess,
    private readonly stderrPromise: Promise<string>,
    private readonly dependencies: TunnelDependencies,
  ) {
    this.baseUrl = `http://127.0.0.1:${localPort}`;
  }

  static async open(
    target: Pick<BrowserListEntry, "name" | "slot">,
    options: TunnelOptions = {},
  ): Promise<LiveViewTunnel> {
    const dependencies = { ...defaults, ...options.dependencies };
    options.signal?.throwIfAborted();
    const localPort = await dependencies.allocatePort();
    options.signal?.throwIfAborted();
    const config = options.remoteHost === undefined ? loadAgentbrowseConfig() : null;
    const remoteHost =
      options.remoteHost ??
      requireConfigured(
        config!.remote.host,
        "remote.host",
        "AGENTBROWSE_REMOTE_HOST",
        config!.path,
      );
    const args = sshArguments(remoteHost, localPort, targetFor(target.name, target.slot).httpPort);
    const child = dependencies.spawn(args);
    const stderrPromise = captureStderr(child.stderr, STDERR_LIMIT);
    const tunnel = new LiveViewTunnel(localPort, target, child, stderrPromise, dependencies);
    try {
      await tunnel.waitUntilReady(options.readyTimeoutMs ?? READY_TIMEOUT_MS, options.signal);
      return tunnel;
    } catch (error) {
      await tunnel.close();
      options.signal?.throwIfAborted();
      const detail = tunnel.stderrText.trim();
      throw new Error(
        `could not connect to Browser target ${target.name}${detail === "" ? "" : `: ${detail}`}`,
        { cause: error },
      );
    }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async waitUntilReady(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    const deadline = this.dependencies.now() + timeoutMs;
    const abort = abortWait(signal);
    try {
      while (this.dependencies.now() < deadline) {
        signal?.throwIfAborted();
        if (this.process.exitCode !== null) {
          await this.process.exited;
          this.stderrText = await this.stderrPromise;
          throw new Error(`SSH tunnel exited with status ${this.process.exitCode}`);
        }
        if (await this.dependencies.probe(`${this.baseUrl}/`, signal)) return;
        await Promise.race([
          this.dependencies.sleep(100),
          this.process.exited.then(() => undefined),
          abort.promise,
        ]);
      }
    } finally {
      abort.dispose();
    }
    throw new Error(`SSH tunnel was not ready within ${timeoutMs} ms`);
  }

  private async closeOnce(): Promise<void> {
    if (this.process.exitCode === null) tryKill(this.process, 15);
    await Promise.race([
      this.process.exited.catch(() => -1),
      this.dependencies.sleep(1_000).then(() => -1),
    ]);
    if (this.process.exitCode === null) tryKill(this.process, 9);
    await this.process.exited.catch(() => -1);
    this.stderrText = await this.stderrPromise.catch(() => "");
  }
}

function abortWait(signal?: AbortSignal): {
  promise: Promise<never>;
  dispose(): void;
} {
  if (!signal) return { promise: new Promise<never>(() => {}), dispose() {} };
  let rejectAbort!: (reason: unknown) => void;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  return {
    promise,
    dispose: () => signal.removeEventListener("abort", onAbort),
  };
}

function tryKill(process: TunnelProcess, signal: number): void {
  try {
    process.kill(signal);
  } catch {
    // The child can exit between the exitCode check and signal delivery.
  }
}

export function sshArguments(
  remoteHost: string,
  localPort: number,
  remotePort: number,
): readonly string[] {
  return [
    "ssh",
    "-N",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-L",
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    remoteHost,
  ];
}

async function allocateLoopbackPort(): Promise<number> {
  const server = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("could not allocate a local port");
    return address.port;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function captureStderr(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let captured = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      if (captured >= limit) continue;
      const remaining = limit - captured;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      captured += chunk.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}
