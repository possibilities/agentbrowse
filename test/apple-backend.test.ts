import { expect, test } from "bun:test";

import { APPLE_NAT_WRAPPER, AppleContainerFarmBackend } from "../cli/apple-backend.ts";
import type { BackendCommand, CommandResult } from "../cli/backend.ts";
import { targetFor } from "../cli/model.ts";
import type { AgentbrowseConfig, AppleContainerBackendConfig } from "../config/deployment.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });

const backendConfig: AppleContainerBackendConfig = {
  id: "apple-container-local",
  type: "apple-container",
  command: "/usr/local/bin/container",
  applicationRoot: "/tmp/agentbrowse-infra/runtime",
  maxTargets: 1,
  cpus: 2,
  memory: "6G",
};

function config(): AgentbrowseConfig {
  return loadAgentbrowseConfig({
    AGENTBROWSE_CONFIG: "/tmp/agentbrowse-apple-test-config-does-not-exist.json",
  });
}

function backend(command: BackendCommand, suffix = "generation1") {
  return new AppleContainerFarmBackend(backendConfig, config(), {
    command,
    readText: () => "agentbrowse-infra-owned-v1\n",
    uniqueSuffix: () => suffix,
    probe: async () => true,
  });
}

function inspectDocument(
  target = targetFor(
    "testing",
    0,
    "apple-container-local",
    "agentbrowse-browser-testing-generation1",
  ),
  image = "browser@test",
): string {
  return JSON.stringify([
    {
      status: "running",
      networks: [{ ipv4Address: "192.168.64.2/24" }],
      configuration: {
        image: { reference: image },
        labels: {
          "dev.agentbrowse.managed": "true",
          "dev.agentbrowse.role": "kernel-browser",
          "dev.agentbrowse.backend": target.backend,
          "dev.agentbrowse.target": target.name,
          "dev.agentbrowse.slot": String(target.slot),
          "dev.agentbrowse.image": image,
        },
        initProcess: {
          executable: "/bin/sh",
          arguments: ["-c", APPLE_NAT_WRAPPER],
          environment: ["ENABLE_WEBRTC=true", `NEKO_WEBRTC_UDPMUX=${target.webrtcPort}`],
        },
      },
    },
  ]);
}

test("stopped Apple service reports manual recovery without starting anything", async () => {
  const calls: string[][] = [];
  const local = backend(async (args) => {
    calls.push([...args]);
    return ok("apiserver is not running and not registered with launchd");
  });

  await expect(local.verifyHost()).rejects.toMatchObject({
    code: "apple_service_stopped",
    recovery: "run agentbrowse-infra enable, then prepare the locked image explicitly",
  });
  expect(calls).toEqual([["/usr/local/bin/container", "system", "status"]]);
});

test("Apple inspection treats an exact empty array as absence", async () => {
  const local = backend(async () => ok("[]"));
  expect(await local.inspectContainer("missing")).toBeUndefined();
});

test("Apple targets use unique names and Direct access from inspect JSON", async () => {
  const local = backend(async () => ok(inspectDocument()), "generation1");
  expect(local.newContainerName("testing")).toBe("agentbrowse-browser-testing-generation1");
  const target = targetFor("testing", 0, local.id, "agentbrowse-browser-testing-generation1");
  const state = await local.inspectContainer(target.container);
  expect(state).toBeDefined();
  await local.verifyContainer(state!, target, "browser@test");
  expect(await local.browserAccess(target, state)).toEqual({
    cdpUrl: "http://192.168.64.2:9222",
    liveViewUrl: "http://192.168.64.2:8080",
    liveViewAccess: { mode: "direct", baseUrl: "http://192.168.64.2:8080" },
  });
});

test("Apple launch is bounded to 2 CPUs, 6G, exact labels, and no publish or privilege", async () => {
  let call: readonly string[] = [];
  const local = backend(async (args) => {
    call = args;
    return ok("created");
  });
  const target = targetFor("testing", 4, local.id, "agentbrowse-browser-testing-generation1");

  await local.runBrowser({ target, image: "browser@test", nekoLogLevel: "info" });

  expect(call).toContain("--rosetta");
  expect(call).toContain("--tmpfs");
  expect(call).not.toContain("--publish");
  expect(call).not.toContain("--privileged");
  expect(call.slice(call.indexOf("--cpus"), call.indexOf("--cpus") + 2)).toEqual(["--cpus", "2"]);
  expect(call.slice(call.indexOf("--memory"), call.indexOf("--memory") + 2)).toEqual([
    "--memory",
    "6G",
  ]);
  expect(call).toContain("dev.agentbrowse.managed=true");
  expect(call).toContain("dev.agentbrowse.backend=apple-container-local");
  expect(call).toContain("dev.agentbrowse.target=testing");
  expect(call).toContain("dev.agentbrowse.slot=4");
  expect(call).toContain(APPLE_NAT_WRAPPER);
});

test("wrong Apple application root is an ownership failure, not availability", async () => {
  const local = backend(async () =>
    ok("apiserver is running\napplication data root: /tmp/foreign/runtime"),
  );
  await expect(local.verifyHost()).rejects.toMatchObject({
    code: "apple_application_root_mismatch",
  });
});

test("foreign Apple containers stop inventory before any mutation", async () => {
  const foreign = JSON.parse(inspectDocument()) as Array<{
    configuration: { labels: Record<string, string> };
  }>;
  foreign[0]!.configuration.labels["dev.agentbrowse.backend"] = "foreign";
  const calls: string[][] = [];
  const local = backend(async (args) => {
    calls.push([...args]);
    return args[1] === "list" ? ok("foreign-container") : ok(JSON.stringify(foreign));
  });

  await expect(local.listManagedContainers()).rejects.toMatchObject({
    code: "apple_foreign_container",
  });
  expect(calls.some((args) => args.includes("delete"))).toBe(false);
});
