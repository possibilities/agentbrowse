import { expect, test } from "bun:test";

import type { BrowserListEntry } from "../cli/farm.ts";
import { connectionDescriptor, encodeConnectionDescriptor } from "../client/connection.ts";
import { listBrowserTargets } from "../client/targets.ts";
import { LiveViewTunnel, sshArguments } from "../client/tunnel.ts";

const entries: BrowserListEntry[] = [
  {
    name: "ready",
    slot: 1,
    container: "agentbrowse-browser-ready",
    state: "running",
    status: "Up 2 minutes",
    cdpUrl: "http://100.64.0.8:9223",
    liveViewUrl: "http://127.0.0.1:18081",
    slotConflict: false,
  },
  {
    name: "stopped",
    slot: 2,
    container: "agentbrowse-browser-stopped",
    state: "exited",
    status: "Exited (0)",
    cdpUrl: "http://100.64.0.8:9224",
    liveViewUrl: "http://127.0.0.1:18082",
    slotConflict: false,
  },
  {
    name: "collision",
    slot: 3,
    container: "agentbrowse-browser-collision",
    state: "running",
    status: "Up 1 minute",
    cdpUrl: "http://100.64.0.8:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    slotConflict: true,
  },
];

test("Browser-target choices preserve unavailable targets with reasons", async () => {
  const choices = await listBrowserTargets({ list: async () => entries });
  expect(
    choices.map(({ name, selectable, disabledReason }) => ({ name, selectable, disabledReason })),
  ).toEqual([
    { name: "ready", selectable: true, disabledReason: null },
    { name: "stopped", selectable: false, disabledReason: "Exited (0)" },
    { name: "collision", selectable: false, disabledReason: "slot 3 conflict" },
  ]);
});

test("connection descriptors point at the per-session local tunnel", () => {
  const descriptor = connectionDescriptor(entries[0]!, "http://127.0.0.1:49152");
  expect(descriptor).toEqual({
    version: 1,
    label: "agentbrowse/ready",
    base_url: "http://127.0.0.1:49152",
    username: "kernel",
    password: "admin",
    read_only: false,
  });
  expect(JSON.parse(new TextDecoder().decode(encodeConnectionDescriptor(descriptor)))).toEqual(
    descriptor,
  );
});

test("SSH forwarding uses an ephemeral local port and hardened liveness options", () => {
  expect(sshArguments("browser-host", 49152, 18081)).toEqual([
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
    "127.0.0.1:49152:127.0.0.1:18081",
    "browser-host",
  ]);
});

test("aborting tunnel startup reaps the SSH child before rejecting", async () => {
  let exitCode: number | null = null;
  let finish!: (code: number) => void;
  let didSpawn!: () => void;
  const exited = new Promise<number>((resolve) => {
    finish = resolve;
  });
  const spawned = new Promise<void>((resolve) => {
    didSpawn = resolve;
  });
  const signals: number[] = [];
  const child = {
    exited,
    get exitCode(): number | null {
      return exitCode;
    },
    stderr: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    }),
    kill(signal = 15) {
      signals.push(signal);
      exitCode = 128 + signal;
      finish(exitCode);
    },
  };
  const controller = new AbortController();
  const opening = LiveViewTunnel.open(entries[0]!, {
    remoteHost: "browser-host",
    signal: controller.signal,
    dependencies: {
      allocatePort: async () => 49_152,
      spawn: () => {
        didSpawn();
        return child;
      },
      probe: async () => false,
      sleep: () => new Promise<void>(() => {}),
      now: () => 0,
    },
  });
  await spawned;
  controller.abort();
  const result = await opening.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBe(controller.signal.reason);
  expect(signals).toEqual([15]);
  expect(await exited).toBe(143);
});
