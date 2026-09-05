#!/usr/bin/env bun
/** Repeatable comparison without changing the default backend order or real profiles. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserFarm } from "../cli/runtime.ts";
import { runView } from "../cli/view.ts";
import { CdpConnection, normalizeDebuggerUrl, TemporaryCdpPage } from "../client/cdp.ts";

const names = ["artbird-docker", "apple-local", "hypeman-artbird", "hypeman-local"] as const;
const directory = join(homedir(), ".config", "agentbrowse", "demos");
const [action, selected] = process.argv.slice(2);
if (
  !action ||
  !["configure", "up", "check", "view", "down"].includes(action) ||
  (action !== "configure" && !names.includes(selected as (typeof names)[number]))
) {
  throw new Error(
    `usage: bun tools/browser-demo.ts configure | up|check|view|down ${names.join("|")}`,
  );
}
async function ssh(args: string[]): Promise<string> {
  const child = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "artbird", ...args],
    { stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`artbird setup read failed: ${err}`);
  return out.trim();
}
if (action === "configure") {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const base = JSON.parse(
    await readFile(join(homedir(), ".config/agentbrowse/config.json"), "utf8"),
  );
  const address = await ssh(["tailscale", "ip", "-4"]);
  const tokenFile = join(directory, "artbird-hypeman.token");
  await writeFile(
    tokenFile,
    await ssh(["sudo", "-n", "cat", "/var/lib/agentbrowse-hypeman/token"]),
    { mode: 0o600 },
  );
  const docker = base.backends.find((b: { type: string }) => b.type === "docker");
  const apple = base.backends.find((b: { type: string }) => b.type === "apple-container");
  if (!docker || !apple)
    throw new Error("installed deployment must describe the existing Docker and Apple backends");
  const backends = {
    "artbird-docker": { ...docker, video: base.browser.video },
    "apple-local": {
      ...apple,
      accessMode: "loopback",
      maxTargets: 1000,
      cpus: 2,
      memory: "3G",
      video: base.browser.video,
    },
    "hypeman-artbird": {
      id: "hypeman-artbird",
      type: "hypeman",
      baseUrl: `http://${address}:4973`,
      tokenFile,
      remoteHost: "artbird",
      networkAddress: address,
      cpus: 2,
      memory: "3G",
      portOffset: 2000,
    },
    "hypeman-local": {
      id: "hypeman-local",
      type: "hypeman",
      baseUrl: "http://127.0.0.1:4973",
      tokenFile: join(homedir(), ".local/share/ab-hypeman/token"),
      cpus: 2,
      memory: "3G",
      portOffset: 2000,
    },
  };
  for (const name of names)
    await writeFile(
      join(directory, `${name}.json`),
      `${JSON.stringify({ ...base, backends: [backends[name]] }, null, 2)}\n`,
      { mode: 0o600 },
    );
  console.log(`Prepared comparison configurations in ${directory}`);
} else {
  const name = `demo-${selected}`;
  const env = {
    ...process.env,
    AGENTBROWSE_CONFIG: join(directory, `${selected}.json`),
    AGENTBROWSE_STATE_DIR: join(homedir(), ".local/state/agentbrowse-demo"),
  };
  const farm = browserFarm(env);
  if (action === "down") {
    for (const suffix of ["", "-second"]) {
      await farm.destroy(name + suffix);
      await farm.deleteProfile(name + suffix);
    }
    console.log(`Removed only ${selected} demo targets and profiles`);
  } else if (action === "view") {
    process.exitCode = await runView(name, env);
  } else {
    const start = performance.now();
    let target = await farm.create({ name, slot: 100 });
    const launchMs = performance.now() - start;
    const url =
      "data:text/html," +
      encodeURIComponent(
        `<!doctype html><html><head><title>${selected} browser demo</title><style>body{background:#172126;color:#edf5eb;font:24px system-ui;padding:6vw}h1{font-size:56px}button,input{font:inherit;padding:12px;margin:8px}button{background:#bbe5a4;border:0;border-radius:8px}#count{font-size:48px;color:#bbe5a4}</style></head><body><p>AGENTBROWSE · BACKEND COMPARISON</p><h1>${selected}</h1><p>A real browser with a durable profile and interactive Live View.</p><input placeholder="Type here"><button onclick="document.querySelector('#count').textContent=++window.count">Click me</button><p id="count">0</p><script>window.count=0</script></body></html>`,
      );
    async function connection(cdpUrl: string) {
      const version = (await (
        await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(5000) })
      ).json()) as { webSocketDebuggerUrl: string };
      return CdpConnection.connect(normalizeDebuggerUrl(cdpUrl, version.webSocketDebuggerUrl));
    }
    const cdp = await connection(target.cdpUrl);
    try {
      await cdp.command("Target.createTarget", { url });
    } finally {
      cdp.close();
    }
    if (action === "check") {
      const page = await TemporaryCdpPage.open(target.cdpUrl, url);
      try {
        const result = await page.evaluate<number>(
          "new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const timer = setInterval(() => { const button = document.querySelector('button'); if (document.readyState === 'complete' && button && typeof window.count === 'number') { clearInterval(timer); button.click(); resolve(window.count); } else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('demo page did not load')); } }, 20); })",
        );
        if (result !== 1) throw new Error("browser JavaScript/input check failed");
      } finally {
        await page.close();
      }
      const cookieName = "agentbrowse_demo_persistence";
      const cookieValue = crypto.randomUUID();
      const before = await connection(target.cdpUrl);
      try {
        await before.command("Storage.setCookies", {
          cookies: [
            {
              name: cookieName,
              value: cookieValue,
              domain: "example.com",
              path: "/",
              expires: Math.floor(Date.now() / 1000) + 86400,
            },
          ],
        });
        // A normal browser close flushes its profile before terminating the VM.
        await before.command("Browser.close").catch(() => undefined);
      } finally {
        before.close();
      }
      await Bun.sleep(1500);
      const oldContainer = target.container;
      await farm.destroy(name);
      target = await farm.create({ name, slot: 100 });
      if (target.container === oldContainer && selected?.startsWith("hypeman"))
        throw new Error("Hypeman reused an old instance identity");
      const after = await connection(target.cdpUrl);
      try {
        const result = await after.command<{ cookies: { name: string; value: string }[] }>(
          "Storage.getCookies",
        );
        if (!result.cookies.some((c) => c.name === cookieName && c.value === cookieValue))
          throw new Error("profile cookie did not survive recreation");
        await after.command("Target.createTarget", { url });
      } finally {
        after.close();
      }
      const second = await farm.create({ name: `${name}-second`, slot: 101 });
      try {
        if (second.container === target.container)
          throw new Error("second browser is not independent");
        const probe = await connection(second.cdpUrl);
        probe.close();
      } finally {
        await farm.destroy(`${name}-second`);
        await farm.deleteProfile(`${name}-second`);
      }
      const survivor = await connection(target.cdpUrl);
      try {
        await survivor.command("Browser.getVersion");
      } finally {
        survivor.close();
      }
      console.log(
        JSON.stringify({
          backend: selected,
          launchMs,
          cdp: true,
          profilePersistence: true,
          concurrentBrowsers: true,
          target: target.name,
          cdpUrl: target.cdpUrl,
        }),
      );
    } else
      console.log(
        JSON.stringify({ backend: selected, launchMs, target: target.name, cdpUrl: target.cdpUrl }),
      );
  }
}
