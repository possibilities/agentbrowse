import assert from "node:assert/strict";
import type { BrowserDescription } from "../cli/model.ts";
import { browserFarm } from "../cli/runtime.ts";
import { CdpConnection, normalizeDebuggerUrl } from "../client/cdp.ts";

const browsers = browserFarm();
const nonce = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const profile = `session-proof-${nonce}`;
const a = `owner-a-${nonce}`;
const b = `owner-b-${nonce}`;
const disposable = `public-${nonce}`;
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
  const publicSession = await browsers.sessions.launch(disposable);
  assert.equal(publicSession.receipt.persistent, false);
  await browsers.sessions.release(disposable, publicSession.receipt.lease);
  assert.equal(
    (await browsers.listProfiles()).some((p) => p.name === publicSession.receipt.profile),
    false,
  );
  const first = await browsers.sessions.prepare(a, profile);
  const running = await browsers.sessions.launch(a);
  await assert.rejects(browsers.sessions.prepare(b, profile), { code: "profile_leased" });
  await profileData(running.result, true);
  await browsers.sessions.release(a, first.lease);
  const second = await browsers.sessions.prepare(b, profile);
  const reopened = await browsers.sessions.launch(b);
  assert.notEqual(reopened.result.name, running.result.name);
  await profileData(reopened.result, false);
  assert.deepEqual(await browsers.sessions.release(a, first.lease), { released: false });
  await browsers.sessions.release(b, second.lease);
  console.log(
    JSON.stringify({
      ok: true,
      disposableRemoved: true,
      exclusiveOwner: true,
      cookie: true,
      localStorage: true,
      indexedDB: true,
      successiveOwners: true,
    }),
  );
} finally {
  for (const session of [disposable, a, b]) {
    const receipt = await browsers.sessions.read(session);
    if (receipt) await browsers.sessions.release(session, receipt.lease);
  }
  await browsers.deleteProfile(profile);
}
