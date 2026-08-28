import { expect, test } from "bun:test";

import { type BackendCommand, type CommandResult, DockerFarmBackend } from "../cli/backend.ts";
import { profileFor, targetFor } from "../cli/model.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function backend(command: BackendCommand, commandTimeoutMs = 2_000): DockerFarmBackend {
  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: "/tmp/agentbrowse-backend-test-does-not-exist.json",
    AGENTBROWSE_DOCKER_CONTEXT: "remote-browser",
    AGENTBROWSE_DOCKER_ENDPOINT: "ssh://remote-browser",
    AGENTBROWSE_DOCKER_ENGINE: "browser-engine",
    AGENTBROWSE_REMOTE_HOST: "remote-browser",
    AGENTBROWSE_NETWORK_ADDRESS_COMMAND: "network-tool address --ipv4",
  });
  return new DockerFarmBackend({ ...config, discovery: { commandTimeoutMs } }, { command });
}

test("remote discovery has a shorter host deadline when the caller supplies cancellation", async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  const command: BackendCommand = async (args, signal) => {
    seenSignals.push(signal);
    if (args[1] === "context") return ok("ssh://remote-browser");
    return await new Promise<CommandResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const discovery = backend(command, 5);

  await expect(discovery.verifyHost(new AbortController().signal)).rejects.toMatchObject({
    code: "browser_host_unreachable",
    message: "Browser host is offline or unreachable",
  });
  expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
  expect(seenSignals[1]).toBeInstanceOf(AbortSignal);
  expect(seenSignals[1]?.aborted).toBe(true);
});

test("ordinary lifecycle commands retain their existing unbounded transport behavior", async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  const discovery = backend(async (args, signal) => {
    seenSignals.push(signal);
    return args[1] === "context" ? ok("ssh://remote-browser") : ok("browser-engine");
  });

  await discovery.verifyHost();

  expect(seenSignals).toEqual([undefined, undefined]);
});

test("caller cancellation remains distinct from an internal discovery deadline", async () => {
  let startRemote!: () => void;
  const remoteStarted = new Promise<void>((resolve) => {
    startRemote = resolve;
  });
  const discovery = backend(async (args, signal) => {
    if (args[1] === "context") return ok("ssh://remote-browser");
    startRemote();
    return await new Promise<CommandResult>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  const controller = new AbortController();
  const cancelled = new Error("picker closed");
  const verifying = discovery.verifyHost(controller.signal);
  await remoteStarted;
  controller.abort(cancelled);

  expect(await verifying.catch((error: unknown) => error)).toBe(cancelled);
});

const classifiedFailures = [
  {
    stderr: "ssh: Could not resolve hostname remote-browser: nodename nor servname provided",
    code: "browser_host_unresolved",
    message: "Browser host could not be resolved",
  },
  {
    stderr: "remote-browser: Permission denied (publickey).",
    code: "browser_host_authentication_failed",
    message: "Browser host authentication failed",
  },
  {
    stderr: "ssh: connect to host remote-browser port 22: Connection refused",
    code: "browser_host_not_accepting_connections",
    message: "Browser host is not accepting connections",
  },
  {
    stderr: "Cannot connect to the Docker daemon. Is the docker daemon running?",
    code: "browser_service_unavailable",
    message: "Browser service is unavailable",
  },
  {
    stderr: "ssh: connect to host remote-browser port 22: Operation timed out",
    code: "browser_host_unreachable",
    message: "Browser host is offline or unreachable",
  },
] as const;

for (const expected of classifiedFailures) {
  test(`remote discovery classifies ${expected.code}`, async () => {
    const discovery = backend(async (args) =>
      args[1] === "context"
        ? ok("ssh://remote-browser")
        : { exitCode: 1, stdout: "", stderr: expected.stderr },
    );

    await expect(discovery.verifyHost(new AbortController().signal)).rejects.toMatchObject({
      code: expected.code,
      message: expected.message,
    });
  });
}

test("unknown remote failures retain their diagnostic detail", async () => {
  const discovery = backend(async (args) =>
    args[1] === "context"
      ? ok("ssh://remote-browser")
      : { exitCode: 17, stdout: "", stderr: "unexpected remote response" },
  );

  await expect(discovery.verifyHost(new AbortController().signal)).rejects.toMatchObject({
    code: "command_failed",
    message: "docker info failed: unexpected remote response",
  });
});

test("browser launch mounts the exact durable profile volume writable", async () => {
  const seen: string[][] = [];
  const docker = backend(async (args) => {
    seen.push([...args]);
    return ok("container-id");
  });
  const target = targetFor("testing-deadbeef", 3, "testing");
  const profile = profileFor("testing");

  await docker.runBrowser({
    target,
    profile,
    image: "agentbrowse/kernel-headful:test",
    networkAddress: "100.64.0.8",
    nekoLogLevel: "info",
  });

  expect(seen).toHaveLength(1);
  expect(seen[0]).toContain("dev.agentbrowse.profile=testing");
  const mountIndex = seen[0]!.indexOf("--mount");
  expect(seen[0]?.[mountIndex + 1]).toBe(
    "type=volume,src=agentbrowse-profile-testing,dst=/home/kernel/user-data",
  );
});

test("managed profile discovery parses only exact labeled volumes", async () => {
  const docker = backend(async (args) => {
    if (args[3] === "volume" && args[4] === "list") {
      return ok("signed-in\tagentbrowse-profile-signed-in");
    }
    return ok();
  });

  expect(await docker.listManagedProfiles()).toEqual([
    { name: "signed-in", volume: "agentbrowse-profile-signed-in" },
  ]);
});
