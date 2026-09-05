#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const [name, ...command] = process.argv.slice(2);
if (!name || command.length === 0)
  throw new Error("usage: bun tools/hypeman-exec.ts INSTANCE COMMAND [ARG...]");
const backend = loadAgentbrowseConfig().backends.find((b) => b.type === "hypeman");
if (backend?.type !== "hypeman")
  throw new Error("select one Hypeman backend with AGENTBROWSE_CONFIG");
const socket = new WebSocket(
  `${backend.baseUrl.replace(/^http/, "ws")}/instances/${encodeURIComponent(name)}/exec`,
  {
    headers: { Authorization: `Bearer ${readFileSync(backend.tokenFile, "utf8").trim()}` },
  },
);
socket.binaryType = "arraybuffer";
const timer = setTimeout(() => {
  socket.close();
  process.exit(1);
}, 35000);
socket.onopen = () =>
  socket.send(JSON.stringify({ command, tty: false, timeout: 30, wait_for_agent: 10 }));
socket.onmessage = (event) => {
  if (typeof event.data === "string") {
    const value = JSON.parse(event.data);
    if (value.error) console.error(value.error);
    if (typeof value.exitCode === "number") {
      clearTimeout(timer);
      socket.close();
      process.exit(value.exitCode);
    }
  } else {
    process.stdout.write(Buffer.from(event.data as ArrayBuffer));
  }
};
socket.onerror = () => {
  clearTimeout(timer);
  console.error("Hypeman exec WebSocket failed");
  process.exit(1);
};
