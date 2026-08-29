import { expect, test } from "bun:test";

import type { CreateResult, DestroyResult } from "../cli/farm.ts";
import { handleProviderRequest } from "../cli/provider.ts";

const PROTOCOL = "agent-browser.plugin.v1";

class FakeProviderFarm {
  provisioned: string[] = [];
  destroyed: Array<{ name: string; backend?: string }> = [];
  created = true;

  async provision(options: { name: string }): Promise<CreateResult> {
    this.provisioned.push(options.name);
    return {
      name: options.name,
      backend: "artbird",
      slot: 4,
      container: `agentbrowse-browser-${options.name}`,
      httpPort: 18084,
      webrtcPort: 56004,
      cdpPort: 9226,
      image: "agentbrowse/kernel-headful:test",
      cdpUrl: "http://100.64.0.8:9226",
      liveViewUrl: "http://127.0.0.1:18084",
      liveViewAccess: { mode: "ssh", remoteHost: "artbird", remotePort: 18084 },
      created: this.created,
    };
  }

  async destroy(name: string, backend?: string): Promise<DestroyResult> {
    this.destroyed.push({ name, ...(backend === undefined ? {} : { backend }) });
    return {
      name,
      backend: backend ?? "artbird",
      container: `agentbrowse-browser-${name}`,
      destroyed: true,
    };
  }
}

function request(type: string, capability: string, body: Record<string, unknown>): string {
  return JSON.stringify({ protocol: PROTOCOL, type, capability, request: body });
}

test("provider advertises the browser provider manifest", async () => {
  const farm = new FakeProviderFarm();
  const response = JSON.parse(
    await handleProviderRequest(request("plugin.manifest", "plugin.manifest", {}), farm),
  );

  expect(response).toEqual({
    protocol: PROTOCOL,
    success: true,
    manifest: {
      name: "agentbrowse",
      capabilities: ["browser.provider"],
      description: "Manage ordered Kernel browser backends",
    },
  });
});

test("browser.launch provisions the session target and returns cleanup data", async () => {
  const farm = new FakeProviderFarm();
  const response = JSON.parse(
    await handleProviderRequest(
      request("browser.launch", "browser.provider", {
        provider: "remote-browser",
        session: "demo",
        launchOptions: { engine: "chrome", headed: true },
      }),
      farm,
    ),
  );

  expect(farm.provisioned).toEqual(["demo"]);
  expect(response).toMatchObject({
    protocol: PROTOCOL,
    success: true,
    browser: {
      cdpUrl: "http://100.64.0.8:9226",
      directPage: false,
      metadata: {
        backend: "artbird",
        browserTarget: "demo",
        slot: 4,
        liveViewUrl: "http://127.0.0.1:18084",
      },
      cleanup: { backend: "artbird", browserTarget: "demo" },
    },
  });
});

test("browser.launch maps agent-browser session names outside the target grammar", async () => {
  const farm = new FakeProviderFarm();
  await handleProviderRequest(
    request("browser.launch", "browser.provider", {
      session: "Demo_Worktree",
      launchOptions: { engine: "chrome" },
    }),
    farm,
  );

  expect(farm.provisioned[0]).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
});

test("browser.close always destroys the browser target named by cleanup data", async () => {
  const farm = new FakeProviderFarm();
  const response = JSON.parse(
    await handleProviderRequest(
      request("browser.close", "browser.provider", {
        backend: "apple-container-local",
        browserTarget: "demo",
      }),
      farm,
    ),
  );

  expect(farm.destroyed).toEqual([{ name: "demo", backend: "apple-container-local" }]);
  expect(response).toMatchObject({
    protocol: PROTOCOL,
    success: true,
    data: { backend: "apple-container-local", browserTarget: "demo", destroyed: true },
  });
});

test("browser.launch returns cleanup data for an already-running target", async () => {
  const farm = new FakeProviderFarm();
  farm.created = false;
  const response = JSON.parse(
    await handleProviderRequest(
      request("browser.launch", "browser.provider", {
        session: "demo",
        launchOptions: { engine: "chrome" },
      }),
      farm,
    ),
  );

  expect(response.browser.cleanup).toEqual({ backend: "artbird", browserTarget: "demo" });
});

test("provider failures remain valid protocol responses", async () => {
  const farm = new FakeProviderFarm();
  const invalidJson = JSON.parse(await handleProviderRequest("not-json", farm));
  const wrongEngine = JSON.parse(
    await handleProviderRequest(
      request("browser.launch", "browser.provider", {
        session: "demo",
        launchOptions: { engine: "lightpanda" },
      }),
      farm,
    ),
  );

  expect(invalidJson).toMatchObject({ protocol: PROTOCOL, success: false });
  expect(wrongEngine).toMatchObject({ protocol: PROTOCOL, success: false });
  expect(wrongEngine.error).toContain("require the chrome engine");
  expect(farm.provisioned).toHaveLength(0);
});
