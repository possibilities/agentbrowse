import { expect, test } from "bun:test";

import {
  type BackendCommand,
  browserVideoVariables,
  type CommandResult,
  type ContainerState,
  canonicalJson,
  DockerFarmBackend,
  verifyBrowserVideoEnvironment,
} from "../cli/backend.ts";
import { CHROMIUM_FLAGS, profileFor, targetFor } from "../cli/model.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

function backend(command: BackendCommand, commandTimeoutMs = 2_000): DockerFarmBackend {
  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: "/tmp/agentbrowse-backend-test-does-not-exist.json",
  });
  return new DockerFarmBackend(
    {
      id: "remote-browser",
      type: "docker",
      context: "remote-browser",
      expectedEndpoint: "ssh://remote-browser",
      expectedEngine: "browser-engine",
      remoteHost: "remote-browser",
      networkAddress: null,
      networkAddressCommand: "network-tool address --ipv4",
    },
    { ...config, discovery: { commandTimeoutMs } },
    { command },
  );
}

test("video environment retains complete Neko VP8 pipelines and rejects compatibility overrides", () => {
  const video = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: "/tmp/agentbrowse-backend-test-does-not-exist.json",
  }).browser.video;
  const variables = browserVideoVariables(video);
  expect(variables.slice(0, 2)).toEqual([
    "NEKO_DESKTOP_SCREEN=1920x1080@60",
    "NEKO_CAPTURE_VIDEO_IDS=main",
  ]);
  const pipelineVariable = variables[2]!;
  const pipelines = JSON.parse(pipelineVariable.slice(pipelineVariable.indexOf("=") + 1));
  const gstParams = {
    "buffer-initial-size": "(3072 * 2)",
    "buffer-optimal-size": "(3072 * 3)",
    "buffer-size": "(3072 * 4)",
    "cpu-used": "4",
    deadline: "1",
    "end-usage": "cbr",
    "keyframe-max-dist": "30",
    "max-quantizer": "20",
    "min-quantizer": "4",
    "target-bitrate": "round(2396160)",
    threads: "4",
    undershoot: "95",
  };
  expect(pipelines).toEqual({
    legacy: { fps: "30", gst_encoder: "vp8enc", gst_params: gstParams, show_pointer: true },
    main: { fps: "30", gst_encoder: "vp8enc", gst_params: gstParams, show_pointer: false },
  });

  const state: ContainerState = {
    image: "browser@test",
    labels: {},
    environment: variables,
    command: [],
    running: true,
    addresses: [],
    bindings: {},
    mounts: [],
  };
  expect(() => verifyBrowserVideoEnvironment(state, video, "testing")).not.toThrow();
  expect(() =>
    verifyBrowserVideoEnvironment(
      { ...state, environment: variables.slice(0, 2) },
      video,
      "testing",
    ),
  ).toThrow("uses different Live View capture settings");
  expect(() =>
    verifyBrowserVideoEnvironment(
      { ...state, environment: [variables[0]!.replace("@60", "@30"), ...variables.slice(1)] },
      video,
      "testing",
    ),
  ).toThrow("uses different Live View capture settings");
  for (const compatibilityOverride of ["NEKO_SCREEN=1920x1080@25", "NEKO_LEGACY=false"]) {
    expect(() =>
      verifyBrowserVideoEnvironment(
        { ...state, environment: [...variables, compatibilityOverride] },
        video,
        "testing",
      ),
    ).toThrow("overrides Live View capture compatibility settings");
  }
  expect(canonicalJson({ z: 1, a: { z: 2, a: 3 }, m: [{ b: 1, a: 2 }] })).toBe(
    '{"a":{"a":3,"z":2},"m":[{"a":2,"b":1}],"z":1}',
  );
});

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
    if (args[0] === "ssh") return ok("192.0.2.10");
    return ok("container-id");
  });
  const target = targetFor("testing-deadbeef", 3, {
    profile: "testing",
    backend: "remote-browser",
  });

  await docker.runBrowser({
    target,
    image: "agentbrowse/kernel-headful:test",
    nekoLogLevel: "info",
  });

  expect(seen).toHaveLength(2);
  expect(seen[1]).toContain("dev.agentbrowse.profile=testing");
  const mountIndex = seen[1]!.indexOf("--mount");
  expect(seen[1]?.[mountIndex + 1]).toBe(
    "type=volume,src=agentbrowse-profile-testing,dst=/home/kernel/user-data",
  );
  expect(seen[1]).toContain("NEKO_DESKTOP_SCREEN=1920x1080@60");
  expect(seen[1]).toContain("NEKO_CAPTURE_VIDEO_IDS=main");
  expect(seen[1]?.some((value) => value.includes('"keyframe-max-dist":"30"'))).toBe(true);
});

test("Docker launch and verification use the backend video override", async () => {
  const config = loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: `${import.meta.dir}/../config.example.json`,
  });
  const backendConfig = config.backends[0];
  if (backendConfig?.type !== "docker" || backendConfig.video === undefined) {
    throw new Error("config.example.json must define a Docker video override");
  }

  const seen: string[][] = [];
  const docker = new DockerFarmBackend(backendConfig, config, {
    command: async (args) => {
      seen.push([...args]);
      return ok("container-id");
    },
  });
  const target = targetFor("testing-deadbeef", 3, {
    profile: "testing",
    backend: backendConfig.id,
  });
  const image = "agentbrowse/kernel-headful:test";

  await docker.runBrowser({ target, image, nekoLogLevel: "info" });

  expect(seen).toHaveLength(1);
  expect(seen[0]?.some((value) => value.includes('"fps":"60"'))).toBe(true);

  const stateWithVideo = (environment: readonly string[]): ContainerState => ({
    image,
    labels: {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "kernel-browser",
      "dev.agentbrowse.backend": backendConfig.id,
      "dev.agentbrowse.target": target.name,
      "dev.agentbrowse.profile": target.profile,
      "dev.agentbrowse.slot": String(target.slot),
    },
    environment: [
      "ENABLE_WEBRTC=true",
      `CHROMIUM_FLAGS=${CHROMIUM_FLAGS}`,
      `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`,
      `NEKO_WEBRTC_NAT1TO1=${backendConfig.networkAddress}`,
      ...environment,
    ],
    command: [],
    running: true,
    addresses: [],
    bindings: {
      "8080/tcp": [{ hostIp: "127.0.0.1", hostPort: String(target.httpPort) }],
      [`${target.webrtcPort}/udp`]: [
        { hostIp: backendConfig.networkAddress!, hostPort: String(target.webrtcPort) },
      ],
      "9222/tcp": [{ hostIp: backendConfig.networkAddress!, hostPort: String(target.cdpPort) }],
    },
    mounts: [
      {
        type: "volume",
        name: profileFor(target.profile).volume,
        destination: "/home/kernel/user-data",
        writable: true,
      },
    ],
  });

  await expect(
    docker.verifyContainer(
      stateWithVideo(browserVideoVariables(backendConfig.video)),
      target,
      image,
    ),
  ).resolves.toBeUndefined();
  await expect(
    docker.verifyContainer(
      stateWithVideo(browserVideoVariables(config.browser.video)),
      target,
      image,
    ),
  ).rejects.toMatchObject({ code: "browser_drift" });
});

test("missing profile inspection accepts a remote Docker lowercase response", async () => {
  const docker = backend(async (args) =>
    args[3] === "volume" && args[4] === "inspect"
      ? {
          exitCode: 1,
          stdout: "",
          stderr: "Error response from daemon: get agentbrowse-profile-new: no such volume",
        }
      : ok(),
  );

  expect(await docker.inspectProfile(profileFor("new"))).toBeUndefined();
});

test("managed profile discovery parses only exact labeled volumes", async () => {
  const docker = backend(async (args) => {
    if (args[3] === "volume" && args[4] === "list") {
      return ok("signed-in\tremote-browser\tagentbrowse-profile-signed-in");
    }
    return ok();
  });

  expect(await docker.listManagedProfiles()).toEqual([
    { name: "signed-in", volume: "agentbrowse-profile-signed-in" },
  ]);
});
