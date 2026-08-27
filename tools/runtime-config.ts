#!/usr/bin/env bun

import { runtimeDir } from "../cli/runtime.ts";
import { connectionDescriptor } from "../client/connection.ts";
import { loadAgentbrowseConfig, requireConfigured } from "../config/deployment.ts";

const config = loadAgentbrowseConfig();
const command = process.argv[2];

if (command === "shell") {
  const context = requireConfigured(
    config.docker.context,
    "docker.context",
    "AGENTBROWSE_DOCKER_CONTEXT",
    config.path,
  );
  const remoteHost = requireConfigured(
    config.remote.host,
    "remote.host",
    "AGENTBROWSE_REMOTE_HOST",
    config.path,
  );
  process.stdout.write(`${context}\t${remoteHost}\t${runtimeDir(process.env)}\n`);
} else if (command === "descriptor") {
  const name = process.argv[3];
  const port = Number(process.argv[4]);
  if (name === undefined || !/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error("descriptor requires a valid browser target name");
  }
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("descriptor requires a valid local port");
  }
  process.stdout.write(
    `${JSON.stringify(
      connectionDescriptor({ name }, `http://127.0.0.1:${port}`, {
        labelPrefix: config.liveView.labelPrefix,
        username: config.liveView.username,
        password: config.liveView.password,
        readOnly: config.liveView.readOnly,
      }),
    )}\n`,
  );
} else {
  throw new Error("expected shell or descriptor");
}
