#!/usr/bin/env bun
// Explicit live acceptance test: synthetic profiles only, on one prepared host.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserFarm } from "../cli/farm.ts";
import { BrowserFleet } from "../cli/fleet.ts";
import {
  HYPEMAN_WRAPPER,
  HypemanFarmBackend,
  type HypemanRequest,
} from "../cli/hypeman-backend.ts";
import { type BrowserDescription, PROFILE_DATA_PATH } from "../cli/model.ts";
import { runtimeDir } from "../cli/runtime.ts";
import { CdpConnection, normalizeDebuggerUrl } from "../client/cdp.ts";
import { loadAgentbrowseConfig } from "../config/deployment.ts";

const backendId = process.argv[2];
if (!backendId) throw new Error("usage: bun tools/profile-smoke.ts BACKEND_ID");
const config = loadAgentbrowseConfig();
const settings = config.backends.find((backend) => backend.id === backendId);
if (!settings) throw new Error(`unknown backend: ${backendId}`);
const directory = await mkdtemp(join(tmpdir(), "agentbrowse-native-profile-"));
const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const names = [`profile-source-${nonce}`, `profile-copy-${nonce}`] as const;
let legacySeed = true;
const request: HypemanRequest = async (method, path, body) => {
  if (method === "POST" && path === "/instances" && legacySeed) {
    const launch = body as {
      tags: Record<string, string>;
      volumes: { mount_path: string }[];
      cmd: string[];
    };
    assert.equal(launch.tags["dev.agentbrowse.profile"], names[0]);
    launch.volumes[0]!.mount_path = PROFILE_DATA_PATH;
    delete launch.tags["dev.agentbrowse.profile.layout"];
    // Exercise the real old volume layout and original supervisor policy.
    const bootstrap = HYPEMAN_WRAPPER.slice(HYPEMAN_WRAPPER.indexOf("set -e; rm -f"));
    assert.ok(bootstrap.startsWith("set -e; rm -f"));
    launch.cmd = [bootstrap];
  }
  const response = await fetch(settings.baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${readFileSync(settings.tokenFile, "utf8").trim()}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Hypeman ${method} ${path}: HTTP ${response.status}`);
  return response.status === 204 ? undefined : await response.json();
};
const backend = new HypemanFarmBackend(settings, config, request);
// Share the deployment's allocator, but keep the test's profile bindings private.
const browsers = new BrowserFleet(
  [new BrowserFarm(backend, runtimeDir(process.env), config.browser.nekoLogLevel)],
  directory,
);

async function profileData(target: BrowserDescription, write: boolean) {
  const response = await fetch(`${target.cdpUrl}/json/version`, {
    signal: AbortSignal.timeout(10_000),
  });
  const version = (await response.json()) as { webSocketDebuggerUrl: string };
  const cdp = await CdpConnection.connect(
    normalizeDebuggerUrl(target.cdpUrl, version.webSocketDebuggerUrl),
    30_000,
  );
  function command<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    return cdp.command<T>(method, params, sessionId, 30_000);
  }
  try {
    const page = await command<{ targetId: string }>("Target.createTarget", {
      url: "about:blank",
    });
    const { sessionId } = await command<{ sessionId: string }>("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    // A tiny same-origin 404 document avoids spending the storage test's time
    // rendering Kernel's large OpenAPI JSON in Chromium's JSON viewer.
    const url = "http://127.0.0.1:10001/agentbrowse-profile-smoke";
    await command("Page.navigate", { url }, sessionId);
    let loaded = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await command<{ result: { value: string } }>(
        "Runtime.evaluate",
        { expression: 'location.href + " " + document.readyState', returnByValue: true },
        sessionId,
      );
      if (result.result.value === `${url} complete`) {
        loaded = true;
        break;
      }
      await Bun.sleep(50);
    }
    assert.ok(loaded, "guest fixture origin became ready");
    if (write) {
      const cookie = await command<{ success: boolean }>(
        "Network.setCookie",
        {
          name: "agentbrowse-profile-smoke",
          value: nonce,
          domain: "example.com",
          path: "/",
          expires: Date.now() / 1000 + 3600,
        },
        sessionId,
      );
      assert.ok(cookie.success);
    }
    const expression = `(async () => {
      const write = ${write};
      const token = ${JSON.stringify(nonce)};
      if (write) localStorage.setItem("agentbrowse-smoke", token);
      const database = await new Promise((resolve, reject) => {
        const open = indexedDB.open("agentbrowse-smoke", 1);
        open.onupgradeneeded = () => open.result.createObjectStore("state");
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const value = await new Promise((resolve, reject) => {
        const tx = database.transaction("state", write ? "readwrite" : "readonly");
        const store = tx.objectStore("state");
        const request = write ? store.put(token, "token") : store.get("token");
        tx.oncomplete = () => resolve(write ? token : request.result);
        tx.onerror = () => reject(tx.error);
      });
      database.close();
      return { localStorage: localStorage.getItem("agentbrowse-smoke"), indexedDB: value };
    })()`;
    const data = await command<{ result: { value: unknown }; exceptionDetails?: unknown }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    assert.equal(data.exceptionDetails, undefined);
    assert.deepEqual(data.result.value, { localStorage: nonce, indexedDB: nonce });
    const cookies = await command<{ cookies: { name: string; value: string }[] }>(
      "Storage.getCookies",
    );
    assert.equal(
      cookies.cookies.find((cookie) => cookie.name === "agentbrowse-profile-smoke")?.value,
      nonce,
    );
    await command("Target.closeTarget", { targetId: page.targetId });
  } finally {
    cdp.close();
  }
}

try {
  assert.equal(
    (await backend.listManagedProfiles()).some((profile) =>
      names.includes(profile.name as (typeof names)[number]),
    ),
    false,
  );
  let target = await browsers.provisionProfile({ profile: names[0], readyTimeoutSeconds: 120 });
  console.log("Legacy profile ready; writing synthetic cookie, localStorage, and IndexedDB");
  await profileData(target, true);
  await browsers.destroy(target.name);
  legacySeed = false;
  target = await browsers.provisionProfile({ profile: names[0], readyTimeoutSeconds: 120 });
  await profileData(target, false);
  console.log("Legacy relocation and close/reopen preserved all three stores");
  await backend.withKernel(target, (kernel) => kernel.stop());
  const reopened = await browsers.provisionProfile({ profile: names[0], readyTimeoutSeconds: 120 });
  assert.equal(
    reopened.name,
    target.name,
    "explicit launch restarts a cleanly exited browser in its existing VM",
  );
  await profileData(reopened, false);
  console.log("Explicit relaunch restarted Chromium in the same target with its stored state");
  await browsers.destroy(target.name);
  const archive = join(directory, "profile.tar.zst");
  await browsers.exportProfile(names[0], archive);
  console.log("Native archive exported and temporary VM removed");
  await browsers.importProfile(names[1], archive, backendId);
  target = await browsers.provisionProfile({ profile: names[1], readyTimeoutSeconds: 120 });
  await profileData(target, false);
  await browsers.destroy(target.name);
  console.log("Native configure import and close/reopen preserved all three stores");
} finally {
  // These exact random names belong to this test; force only its disposable VMs
  // if a failed startup left the guest API unavailable.
  legacySeed = false;
  for (const target of await backend.listManagedContainers()) {
    if (names.some((name) => name === target.profile))
      await browsers.destroy(target.name, backendId, target.profile!, true);
  }
  for (const name of names) await browsers.deleteProfile(name);
  assert.equal(
    (await backend.listManagedContainers()).some((target) =>
      names.some((name) => name === target.profile),
    ),
    false,
  );
  assert.equal(
    (await backend.listManagedProfiles()).some((profile) =>
      names.some((name) => name === profile.name),
    ),
    false,
  );
  await rm(directory, { recursive: true, force: true });
  console.log("All synthetic profiles, VMs, and archives removed");
}
