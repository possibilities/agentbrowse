import { expect, test } from "bun:test";
import {
  HYPEMAN_WRAPPER,
  HypemanFarmBackend,
  type HypemanRequest,
} from "../cli/hypeman-backend.ts";
import { KernelBrowser } from "../cli/kernel.ts";
import { profileFor, targetFor } from "../cli/model.ts";
import { type HypemanBackendConfig, loadAgentbrowseConfig } from "../config/deployment.ts";

const config = loadAgentbrowseConfig({
  AGENTBROWSE_CONFIG: "/tmp/agentbrowse-hypeman-nonexistent-config.json",
});
const settings: HypemanBackendConfig = {
  id: "hypeman-test",
  type: "hypeman",
  baseUrl: "http://localhost:4973",
  tokenFile: "/tmp/token",
  remoteHost: null,
  networkAddress: null,
  portOffset: 2000,
  cpus: 4,
  memory: "8G",
  profileSizeGb: 10,
};
const profile = profileFor("signed-in");
const target = targetFor("testing", 7, {
  backend: settings.id,
  profile: profile.name,
  container: "ab-testing-incarnation",
});
const tags = {
  "dev.agentbrowse.managed": "true",
  "dev.agentbrowse.role": "kernel-browser",
  "dev.agentbrowse.backend": settings.id,
  "dev.agentbrowse.target": target.name,
  "dev.agentbrowse.profile": profile.name,
  "dev.agentbrowse.slot": "7",
  "dev.agentbrowse.hypeman.spec": "1",
  "dev.agentbrowse.port-offset": "2000",
};
const volume = {
  id: "vol-exact",
  name: profile.volume,
  tags: {
    "dev.agentbrowse.managed": "true",
    "dev.agentbrowse.role": "browser-profile",
    "dev.agentbrowse.backend": settings.id,
    "dev.agentbrowse.profile": profile.name,
    "dev.agentbrowse.profile.schema": "1",
  },
};
function instance(id = "exact-id") {
  return {
    id,
    name: target.container,
    image: "browser@sha256:test",
    state: "Running",
    tags,
    network: { ip: "192.168.64.42" },
    env: {},
    volumes: [{ volume_id: volume.id, mount_path: "/home/kernel/user-data", readonly: false }],
  };
}

test("launch attaches the exact persistent volume and preserves requested resources and browser transport", async () => {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const backend = new HypemanFarmBackend(settings, config, async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/volumes") return [volume];
    if (path === "/instances" && method === "POST") return instance();
    throw new Error(`unexpected ${method} ${path}`);
  });
  await backend.runBrowser({ target, image: "browser@sha256:test", nekoLogLevel: "info" });
  expect(calls.at(-1)?.body).toMatchObject({
    vcpus: 4,
    size: "8G",
    platform: "linux/amd64",
    volumes: [{ volume_id: "vol-exact", mount_path: "/home/kernel", readonly: false }],
    tags: { "dev.agentbrowse.profile.layout": "2" },
    env: { NEKO_WEBRTC_UDPMUX: "58007" },
    entrypoint: ["/bin/sh", "-c"],
    cmd: [HYPEMAN_WRAPPER],
  });
  expect(calls.some((c) => c.path.startsWith("/images"))).toBe(false);
});

test("stopped and foreign consumers prevent reusing a writable profile", async () => {
  const backend = new HypemanFarmBackend(settings, config, async (_method, path) =>
    path === "/volumes"
      ? [volume]
      : [{ ...instance(), name: "foreign", tags: {}, state: "Stopped" }],
  );
  expect(await backend.listProfileConsumers(profile)).toEqual([
    { container: "foreign", state: "stopped" },
  ]);
  await expect(backend.removeProfile(profile)).rejects.toMatchObject({ code: "profile_in_use" });
});

test("delete rechecks incarnation then deletes by immutable server ID, preserving the volume", async () => {
  const calls: string[] = [];
  const request: HypemanRequest = async (method, path) => {
    calls.push(`${method} ${path}`);
    return path === "/volumes" ? [volume] : method === "GET" ? instance() : undefined;
  };
  let stopped = false;
  let closed = false;
  const backend = new HypemanFarmBackend(settings, config, request, async () => ({
    browser: new (class extends KernelBrowser {
      override async stop() {
        stopped = true;
      }
    })("http://unused"),
    close: async () => {
      closed = true;
    },
  }));
  await backend.inspectContainer(target.container);
  await backend.removeContainer(target.container);
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /instances/exact-id"]);
  expect(stopped).toBe(true);
  expect(closed).toBe(true);
});

test("failed native shutdown preserves the VM and volume until explicitly forced", async () => {
  const calls: string[] = [];
  let closed = false;
  const backend = new HypemanFarmBackend(
    settings,
    config,
    async (method, path) => {
      calls.push(`${method} ${path}`);
      return path === "/volumes" ? [volume] : instance();
    },
    async () => ({
      browser: new (class extends KernelBrowser {
        override async stop() {
          throw new Error("stuck");
        }
      })("http://unused"),
      close: async () => {
        closed = true;
      },
    }),
  );
  await expect(backend.removeContainer(target.container)).rejects.toMatchObject({
    code: "profile_shutdown_failed",
  });
  expect(calls.some((c) => c.startsWith("DELETE"))).toBe(false);
  expect(closed).toBe(true);
  await backend.removeContainer(target.container, true);
  expect(calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /instances/exact-id"]);
});

test("a replacement instance cannot inherit deletion through its reused name", async () => {
  let replacement = false;
  const calls: string[] = [];
  const backend = new HypemanFarmBackend(settings, config, async (method, path) => {
    calls.push(method);
    return path === "/volumes" ? [volume] : instance(replacement ? "replacement" : "original");
  });
  await backend.inspectContainer(target.container);
  replacement = true;
  await expect(backend.removeContainer(target.container)).rejects.toMatchObject({
    code: "foreign_container",
  });
  expect(calls).not.toContain("DELETE");
});

test("a replacement cannot inherit the native stop between initial inspection and Kernel access", async () => {
  let inspections = 0;
  let opened = false;
  const backend = new HypemanFarmBackend(
    settings,
    config,
    async (_method, path) => {
      if (path === "/volumes") return [volume];
      return instance(++inspections === 1 ? "original" : "replacement");
    },
    async () => {
      opened = true;
      throw new Error("must not open");
    },
  );
  await expect(backend.removeContainer(target.container)).rejects.toMatchObject({
    code: "profile_shutdown_failed",
  });
  expect(opened).toBe(false);
});

test("foreign ownership tags block deletion even with a familiar instance name", async () => {
  const backend = new HypemanFarmBackend(settings, config, async (_method, path) =>
    path === "/volumes"
      ? [volume]
      : { ...instance(), tags: { ...tags, "dev.agentbrowse.backend": "somebody-else" } },
  );
  await expect(backend.removeContainer(target.container)).rejects.toMatchObject({
    code: "foreign_container",
  });
});

test("local access uses loopback while remote Live View uses SSH to the VM", async () => {
  const request: HypemanRequest = async (_method, path) =>
    path === "/volumes" ? [volume] : instance();
  const local = new HypemanFarmBackend(settings, config, request);
  expect(await local.browserAccess(target)).toMatchObject({
    cdpUrl: "http://127.0.0.1:11229",
    liveViewAccess: { mode: "direct", baseUrl: "http://127.0.0.1:20087" },
  });
  const remote = new HypemanFarmBackend(
    { ...settings, remoteHost: "artbird", networkAddress: "100.111.14.90" },
    config,
    request,
  );
  expect(await remote.browserAccess(target)).toMatchObject({
    cdpUrl: "http://100.111.14.90:11229",
    liveViewAccess: {
      mode: "ssh",
      remoteHost: "artbird",
      remotePort: 8080,
      remoteAddress: "192.168.64.42",
    },
  });
});

test("malformed successful discovery is an error rather than an availability fallback", async () => {
  const backend = new HypemanFarmBackend(settings, config, async () => ({ instances: [] }));
  await expect(backend.verifyHost()).rejects.toMatchObject({ code: "invalid_hypeman_response" });
});

test("HTTP discovery sends bearer credentials and preserves authentication and malformed-response errors", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = mkdtempSync(join(tmpdir(), "hypeman-http-"));
  const tokenFile = join(directory, "token");
  writeFileSync(tokenFile, "test-bearer-token\n", { mode: 0o600 });
  let status = 200;
  let content = "[]";
  let authorization: string | null = null;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      authorization = request.headers.get("authorization");
      return new Response(content, { status });
    },
  });
  const backend = new HypemanFarmBackend(
    { ...settings, tokenFile, baseUrl: server.url.origin },
    config,
  );
  try {
    await backend.verifyHost();
    expect(String(authorization)).toBe("Bearer test-bearer-token");
    status = 401;
    await expect(backend.verifyHost()).rejects.toMatchObject({
      code: "browser_host_authentication_failed",
    });
    status = 200;
    content = "invalid JSON";
    await expect(backend.verifyHost()).rejects.toMatchObject({ code: "invalid_hypeman_response" });
    status = 404;
    await expect(backend.verifyHost()).rejects.toMatchObject({ code: "invalid_hypeman_response" });
  } finally {
    server.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
});
