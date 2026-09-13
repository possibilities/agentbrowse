#!/usr/bin/env bun
import { createHash, randomBytes } from "node:crypto";
/** Opt-in local Hypeman producer helper. No installation, default changes or saved profiles.
 * Usage: bun tools/screencast/run.ts --url http://127.0.0.1:PORT/ --script SCRIPT.json --output NEW_DIRECTORY --seconds 30
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Target } from "../../cli/model.ts";
import { browserFarm } from "../../cli/runtime.ts";
import type { SessionReceipt } from "../../cli/sessions.ts";
import { loadAgentbrowseConfig } from "../../config/deployment.ts";
import { OBSERVE_CONTROLS } from "./controls.ts";
import { digest, newIntent, publish, waitReply } from "./coordination.ts";
import { ExecPeer } from "./exec.ts";
import { assertOwner } from "./identity.ts";
import { acceptPreparation, boundedDocument, preparationWindow } from "./preparation.ts";
import { SafetyLatch } from "./safety.ts";

type Action =
  | { type: "wait"; ms: number }
  | { type: "click"; selector: string }
  | { type: "fill"; selector: string; value: string }
  | { type: "press"; key: string }
  | { type: "expectValue" | "expectText" | "expectOpen"; selector: string; value: string };
export function validate(
  url: string,
  seconds: number,
  script: unknown,
): asserts script is Action[] {
  const parsed = new URL(url);
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    !parsed.port ||
    Number(parsed.port) < 1024 ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new Error("one explicit http://127.0.0.1:PORT/ origin required");
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 120)
    throw new Error("seconds must be 5..120");
  if (!Array.isArray(script) || script.length < 1 || script.length > 100)
    throw new Error("script must contain 1..100 actions");
  let waits = 0;
  for (const action of script as Record<string, unknown>[]) {
    if (!action || typeof action !== "object") throw new Error("invalid action");
    if (action.type === "wait") {
      if (
        !Number.isInteger(action.ms) ||
        (action.ms as number) < 0 ||
        (action.ms as number) > 10000
      )
        throw new Error("invalid wait");
      waits += action.ms as number;
    } else if (
      ["click", "fill", "expectValue", "expectText", "expectOpen"].includes(action.type as string)
    ) {
      if (typeof action.selector !== "string" || action.selector.length > 500)
        throw new Error("invalid selector");
      if (
        action.type !== "click" &&
        (typeof action.value !== "string" || action.value.length > 4096)
      )
        throw new Error("invalid value");
    } else if (action.type === "press") {
      if (typeof action.key !== "string" || action.key.length > 100) throw new Error("invalid key");
    } else
      throw new Error("unsupported action; arbitrary eval/navigation is not a producer action");
  }
  if (waits > (seconds - 2) * 1000) throw new Error("script waits exceed recording budget");
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i],
      value = args[i + 1];
    if (
      !key ||
      !value ||
      ![
        "--url",
        "--script",
        "--output",
        "--seconds",
        "--prepare-wait",
        "--coordination-wait",
      ].includes(key) ||
      options.has(key)
    )
      throw new Error("usage: --url ORIGIN --script FILE --output NEW_DIRECTORY --seconds 5..120");
    options.set(key, value);
  }
  const url = options.get("--url") ?? "",
    seconds = Number(options.get("--seconds"));
  const coordinationSeconds = Number(options.get("--coordination-wait") ?? "0");
  if (!Number.isInteger(coordinationSeconds) || coordinationSeconds < 0 || coordinationSeconds > 10)
    throw new Error("coordination-wait must be 1..10 seconds when enabled");
  const prepareSeconds = preparationWindow(options.get("--prepare-wait"));
  const scriptPath = resolve(options.get("--script") ?? "");
  if (!options.has("--script")) throw new Error("script path required");
  let script: unknown = prepareSeconds
    ? undefined
    : JSON.parse(boundedDocument(scriptPath).toString());
  validate(url, seconds, prepareSeconds ? [{ type: "wait", ms: 0 }] : script);
  const outputArg = options.get("--output");
  if (!outputArg) throw new Error("new output directory required");
  const root = resolve(outputArg);
  mkdirSync(root, { mode: 0o700 });
  const session = `film-${randomBytes(4).toString("hex")}`;
  const raw = JSON.parse(readFileSync(join(homedir(), ".config/agentbrowse/config.json"), "utf8"));
  raw.backends = raw.backends.filter((b: { id: string }) => b.id === "local");
  if (raw.backends.length !== 1) throw new Error("exactly one existing local backend required");
  const write = (name: string, value: unknown) =>
    writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  write("browse.json", raw);
  write("driver.json", {
    provider: "agentbrowse",
    plugins: [
      {
        name: "agentbrowse",
        command: process.execPath,
        args: [new URL("provider.ts", import.meta.url).pathname, root, session],
        capabilities: ["browser.provider"],
      },
    ],
  });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("AGENT_BROWSER_") && !key.startsWith("AGENTBROWSE_"),
    ),
  );
  Object.assign(env, {
    AGENTBROWSE_CONFIG: join(root, "browse.json"),
    AGENTBROWSE_STATE_DIR: join(root, "state"),
    AGENTBROWSE_RUNTIME_DIR: join(root, "runtime"),
    AGENT_BROWSER_CONFIG: join(root, "driver.json"),
    AGENT_BROWSER_IDLE_TIMEOUT_MS: "30000",
  });
  write("environment.json", {
    AGENTBROWSE_CONFIG: env.AGENTBROWSE_CONFIG,
    AGENTBROWSE_STATE_DIR: env.AGENTBROWSE_STATE_DIR,
    AGENTBROWSE_RUNTIME_DIR: env.AGENTBROWSE_RUNTIME_DIR,
    AGENT_BROWSER_CONFIG: env.AGENT_BROWSER_CONFIG,
    AGENT_BROWSER_IDLE_TIMEOUT_MS: env.AGENT_BROWSER_IDLE_TIMEOUT_MS,
  });
  const farm = browserFarm(env),
    selectedBackend = loadAgentbrowseConfig(env).backends[0];
  if (!selectedBackend) throw new Error("missing backend");
  const backend = selectedBackend;
  if (backend.remoteHost !== null || new URL(backend.baseUrl).hostname !== "127.0.0.1")
    throw new Error("local loopback Hypeman only");
  let peer: ExecPeer | undefined,
    lease: SessionReceipt | undefined,
    target: Target | undefined,
    instanceId: string | undefined;
  let recording = false,
    child: ReturnType<typeof Bun.spawn> | undefined;
  let monitor: ReturnType<typeof setInterval> | undefined,
    checking = false;
  const manifest: Record<string, unknown> = {
    version: 1,
    status: "pending",
    session,
    origin: url,
    actions: [],
    stage: "starting",
    video: null,
  };
  const save = () => {
    write("manifest.tmp", manifest);
    renameSync(join(root, "manifest.tmp"), join(root, "manifest.json"));
  };
  const safety = new SafetyLatch((error) => {
    // Publish failure immediately, including when an action is still awaiting
    // completion, so the native supervisor need not wait for host cleanup.
    publish(root, "helper-failure.json", {
      version: 1,
      session,
      error: String(error),
      stage: manifest.stage,
      utc: Date.now(),
    });
    peer?.fail(error);
    child?.kill("SIGKILL");
  });
  const checkExternalAbort = () => {
    if (existsSync(join(root, "supervisor-abort.json")))
      safety.trip(new Error("supervisor abort; no further dispatch"));
    safety.check();
  };
  const cancel = () => safety.trip(new Error("operator cancellation"));
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  save();
  async function command(argv: string[], timeout = 15000): Promise<string> {
    checkExternalAbort();
    peer?.check();
    if (
      argv[0] === join(homedir(), ".local/bin/agent-browser") &&
      driverPid &&
      driverSocketDir &&
      readFileSync(join(driverSocketDir, `${session}.pid`), "utf8").trim() !== String(driverPid)
    )
      throw new Error("driver incarnation changed; no dispatch");
    const proc = Bun.spawn(argv, { env, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    child = proc;
    const timer = setTimeout(() => proc.kill("SIGKILL"), timeout);
    try {
      let overflow = false;
      const drain = async (stream: ReadableStream<Uint8Array>, limit: number) => {
        const reader = stream.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size <= limit) parts.push(chunk.value);
          else {
            overflow = true;
            proc.kill("SIGKILL");
          }
        }
        return Buffer.concat(parts).toString();
      };
      const [out, err, code] = await Promise.all([
        drain(proc.stdout, 4 * 1024 * 1024),
        drain(proc.stderr, 512 * 1024),
        proc.exited,
      ]);
      if (overflow) throw new Error("command output bound exceeded");
      if (code !== 0)
        throw new Error(`command failed (${code}): ${err.slice(-2000)} ${out.slice(-500)}`);
      return out + (argv[0] === "ffmpeg" ? err : "");
    } finally {
      clearTimeout(timer);
      if (child === proc) child = undefined;
    }
  }
  async function ab(args: string[]): Promise<Record<string, unknown>> {
    const response = JSON.parse(
      await command(
        [
          join(homedir(), ".local/bin/agent-browser"),
          "--namespace",
          session,
          "--session",
          session,
          "--json",
          ...args,
        ],
        args[0] === "open" && args[1] === "about:blank" ? 65000 : 20000,
      ),
    );
    if (!response.success || response.data?.lifecycle?.relaunchedBrowser) {
      const error = new Error("driver failed or replaced target");
      safety.trip(error);
      throw error;
    }
    return response.data;
  }
  async function instance(): Promise<Record<string, unknown>> {
    if (!target) throw new Error("missing target");
    const response = await fetch(
      `${backend.baseUrl}/instances/${encodeURIComponent(target.container)}`,
      {
        headers: { Authorization: `Bearer ${readFileSync(backend.tokenFile, "utf8").trim()}` },
        signal: AbortSignal.timeout(2000),
      },
    );
    if (!response.ok) throw new Error("owned instance unavailable");
    return (await response.json()) as Record<string, unknown>;
  }
  async function verify(): Promise<void> {
    if (!target) throw new Error("missing target receipt");
    const current = await farm.sessions.read(session);
    if (!lease) throw new Error("missing lease");
    instanceId = assertOwner(lease, current, target, await instance(), instanceId);
  }

  async function releaseOwned(): Promise<void> {
    if (!lease || !target || !instanceId)
      throw new Error("cleanup pending: no saved exact lease and instance; no name-only close");
    await verify();
    manifest.cleanupIdentity = { session, lease: lease.lease, target, instanceId };
    // No driver commands during this wait: they would refresh its idle timer.
    if (!driverPid) throw new Error("cleanup pending: driver identity was not captured");
    const deadline = performance.now() + 45000;
    while (true) {
      try {
        process.kill(driverPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
        throw error;
      }
      if (performance.now() > deadline)
        throw new Error("cleanup pending: owned driver did not exit");
      await Bun.sleep(200);
    }
    const detached = JSON.parse(readFileSync(join(root, "driver-detached.json"), "utf8"));
    if (detached.lease !== lease.lease || detached.session !== session)
      throw new Error("cleanup pending: missing exact detach acknowledgement");
    await verify();
    const released = await farm.sessions.release(session, lease.lease, {
      browserTarget: target.name,
      browserProfile: lease.profile,
      backend: target.backend,
      instanceId,
    });
    if (!released.released || (await farm.sessions.read(session)))
      throw new Error("exact lease release not confirmed");
    manifest.driverCleanup = {
      pid: driverPid,
      exited: true,
      method: "official idle-timeout; no signals sent",
    };
  }

  let driverPid: number | undefined;
  let driverSocketDir: string | undefined;
  let pageId: string | undefined;
  let pageTimeOrigin: number | undefined;
  async function pageIdentity(): Promise<void> {
    if (!target) throw new Error("missing target");
    const base = `http://127.0.0.1:${target.cdpPort + backend.portOffset}`;
    const pages = (await (
      await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(2000) })
    ).json()) as { id: string; url: string; type: string }[];
    const matching = pages.filter((p) => p.type === "page" && p.url === url);
    if (matching.length !== 1 || (pageId && matching[0]?.id !== pageId))
      throw new Error("page target replaced or ambiguous");
    pageId = matching[0]?.id;
    const current = (
      await ab([
        "eval",
        "({url:location.href,timeOrigin:performance.timeOrigin,visibility:document.visibilityState})",
      ])
    ).result as { url: string; timeOrigin: number; visibility: string };
    if (
      current.url !== url ||
      current.visibility !== "visible" ||
      (pageTimeOrigin !== undefined && current.timeOrigin !== pageTimeOrigin)
    )
      throw new Error("controlled page navigated or is not the recorded foreground page");
    pageTimeOrigin = current.timeOrigin;
    manifest.pageIdentity = { pageId, timeOrigin: pageTimeOrigin };
  }
  async function geometry(): Promise<void> {
    const g = (await ab(["eval", "({screenX,screenY,innerWidth,innerHeight,devicePixelRatio})"]))
      .result as Record<string, number>;
    if (
      g.screenX !== 0 ||
      g.screenY !== 0 ||
      g.innerWidth !== 1920 ||
      g.innerHeight !== 1080 ||
      g.devicePixelRatio !== 1
    )
      throw new Error("fullscreen geometry not verified");
    manifest.geometry = g;
  }
  async function similarity(a: string, b: string): Promise<number> {
    const log = await command(
      [
        "ffmpeg",
        "-nostdin",
        "-hide_banner",
        "-i",
        a,
        "-i",
        b,
        "-lavfi",
        "[0:v]scale=320:180,format=rgb24[a];[1:v]scale=320:180,format=rgb24[b];[a][b]ssim",
        "-f",
        "null",
        "-",
      ],
      10000,
    );
    const score = /All:([0-9.]+)/.exec(log)?.[1];
    if (!score) throw new Error("missing decoded similarity evidence");
    return Number(score);
  }
  try {
    await ab(["open", "about:blank"]);
    const driver = await ab(["session", "info"]);
    if (!Number.isSafeInteger(driver.pid) || Number(driver.pid) < 2 || driver.active !== true)
      throw new Error("exact driver PID unavailable");
    driverPid = Number(driver.pid);
    driverSocketDir = String(driver.socketDir);
    manifest.driver = driver;
    lease = await farm.sessions.read(session);
    if (!lease?.target || lease.persistent) throw new Error("fresh disposable lease required");
    target = await farm.farms[0]?.readTarget(lease.target.name);
    if (!target) throw new Error("exact target receipt required");
    await verify();
    manifest.lease = lease;
    manifest.target = target;
    manifest.instanceId = instanceId;
    save();
    peer = new ExecPeer(
      backend,
      instanceId as string,
      Number(new URL(url).port),
      (error) => safety.trip(error),
      300 + prepareSeconds,
      checkExternalAbort,
    );
    await peer.connect();
    monitor = setInterval(() => {
      if (checking) return;
      checking = true;
      verify()
        .catch((error) => {
          safety.trip(error);
        })
        .finally(() => {
          checking = false;
        });
    }, 1000);
    const applicationProbe = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    await applicationProbe.body?.cancel();
    if (!applicationProbe.ok)
      throw new Error(`loopback application unavailable: HTTP ${applicationProbe.status}`);
    await peer.grant(Number(new URL(url).port));
    manifest.stage = "granted";
    save();
    await ab(["open", url]);
    const before = (await ab(["eval", "({innerWidth,innerHeight})"])).result as Record<
      string,
      number
    >;
    if (before.innerWidth !== 1920 || before.innerHeight !== 1080) {
      await peer.rpc("fullscreen");
      await Bun.sleep(500);
    }
    await geometry();
    await pageIdentity();
    if (prepareSeconds) {
      const preparationId = randomBytes(16).toString("hex");
      const identity = {
        session,
        lease: lease.lease,
        instanceId,
        target: target.name,
        pageId,
        timeOrigin: pageTimeOrigin,
        url,
      };
      const identitySha256 = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
      const deadline = performance.now() + prepareSeconds * 1000;
      const readyPath = join(root, "prepare-ready.json");
      manifest.stage = "preparing";
      manifest.preparation = {
        preparationId,
        identity,
        identitySha256,
        readyPath,
        scriptPath,
        expiresUtc: new Date(Date.now() + prepareSeconds * 1000).toISOString(),
      };
      save();
      let nextEvidence = 0;
      while (true) {
        checkExternalAbort();
        peer.check();
        if (performance.now() >= deadline)
          throw new Error("preparation deadline expired without acceptance");
        if (performance.now() >= nextEvidence) {
          await verify();
          await geometry();
          await pageIdentity();
          const snapshot = await ab(["snapshot", "-i"]);
          const controls = (await ab(["eval", OBSERVE_CONTROLS])).result;
          const stamp = Date.now();
          const screenshot = join(root, `prepare-${stamp}.png`);
          await ab(["screenshot", screenshot]);
          write("preparation-evidence.tmp", {
            ...(manifest.preparation as object),
            observedUtc: stamp,
            snapshot,
            controls,
            screenshot,
            instruction:
              "Read artifacts only; helper is sole driver. Atomically rename ready JSON after authoring script.",
          });
          renameSync(
            join(root, "preparation-evidence.tmp"),
            join(root, "preparation-evidence.json"),
          );
          nextEvidence = performance.now() + 10000;
        }
        try {
          const ready = boundedDocument(readyPath);
          const scriptBytes = boundedDocument(scriptPath);
          script = acceptPreparation(ready, scriptBytes, preparationId, identitySha256);
          validate(url, seconds, script);
          await verify();
          await geometry();
          await pageIdentity();
          if (performance.now() >= deadline)
            throw new Error("preparation acceptance exceeded deadline");
          manifest.preparationAccepted = { utc: Date.now(), ready: JSON.parse(ready.toString()) };
          writeFileSync(join(root, "accepted-actions.json"), scriptBytes, { mode: 0o600 });
          save();
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await Bun.sleep(200);
      }
    }
    validate(url, seconds, script);
    let stable = 0;
    for (let attempt = 0; attempt < 4 && stable < 2; attempt++) {
      await peer.rpc("snapshot");
      const native = join(root, `ready-native-${attempt}.png`);
      await peer.copy("snapshot", native);
      const page = join(root, `ready-page-${attempt}.png`);
      await ab(["screenshot", page]);
      const score = await similarity(native, page);
      write(`ready-${attempt}.json`, { score });
      stable = score >= 0.98 ? stable + 1 : 0;
      manifest.referenceFrame = native;
      await Bun.sleep(200);
    }
    if (stable < 2) throw new Error("stable captured page not proven");
    manifest.sourceAllocation = await peer.rpc("allocate");
    save();
    const captureDispatch = performance.now();
    manifest.captureDispatch = { utc: Date.now(), monotonicMs: captureDispatch };
    manifest.stage = "recording";
    recording = true;
    save();
    manifest.captureStart = await peer.rpc("start", { seconds });
    publish(root, "browser-capture-started.json", {
      version: 1,
      session,
      pageId,
      captureStart: manifest.captureStart,
      utc: Date.now(),
    });
    save();
    await Bun.sleep(1000); // Bounded stable-page lead-in, retained in source timestamps.
    const actionStart = performance.now();
    const actionReceipts = manifest.actions as unknown[];
    const scriptSha256 =
      (manifest.preparationAccepted as { ready?: { scriptSha256?: string } } | undefined)?.ready
        ?.scriptSha256 ?? digest(Buffer.from(JSON.stringify(script)));
    const coordinationIdentity = {
      session,
      pageId,
      scriptSha256,
      preparationId:
        (manifest.preparation as { preparationId?: string } | undefined)?.preparationId ?? null,
    };
    let actionIndex = 0;
    for (const action of script) {
      peer.check();
      await peer.rpc("status");
      await verify();
      await geometry();
      await pageIdentity();
      if (performance.now() - captureDispatch > (seconds - 2) * 1000)
        throw new Error("actions exceeded recording budget");
      const prefix = `action-${String(actionIndex).padStart(3, "0")}`;
      const intent = newIntent(coordinationIdentity, actionIndex, action);
      const checkCoordination = async () => {
        if (!peer) throw new Error("missing owned peer");
        checkExternalAbort();
        peer.check();
        await peer.rpc("status");
        if (performance.now() - captureDispatch > (seconds - 2) * 1000)
          throw new Error("coordination exceeded capture budget");
      };
      if (coordinationSeconds) {
        const intentSha256 = publish(root, `${prefix}-intent.json`, intent);
        await waitReply(
          join(root, `${prefix}-permit.json`),
          { intentId: intent.intentId, intentSha256, allow: true },
          performance.now() + coordinationSeconds * 1000,
          checkCoordination,
        );
        await verify();
        await geometry();
        await pageIdentity();
        await checkCoordination();
      }
      const start = performance.now();
      let receipt: unknown;
      if (action.type === "wait") await Bun.sleep(action.ms);
      else if (action.type === "click" || action.type === "fill") {
        const p = (
          await ab([
            "eval",
            `(()=>{const e=document.querySelector(${JSON.stringify(action.selector)});if(!e)throw Error('missing control');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
          ])
        ).result as { x: number; y: number };
        const pointer = await peer.rpc("pointer", p);
        receipt = {
          pointer,
          driver: await ab(
            action.type === "click"
              ? ["click", action.selector]
              : ["fill", action.selector, action.value],
          ),
        };
      } else if (action.type === "press") receipt = await ab(["press", action.key]);
      else {
        const deadline = performance.now() + 1500;
        while (true) {
          const value =
            action.type === "expectOpen"
              ? await ab([
                  "eval",
                  `document.querySelector(${JSON.stringify(action.selector)})?.matches(':open')`,
                ])
              : await ab([
                  "get",
                  action.type === "expectValue" ? "value" : "text",
                  action.selector,
                ]);
          const observed =
            action.type === "expectOpen" ? String(value.result) : (value.value ?? value.text);
          if (observed === action.value) {
            receipt = value;
            break;
          }
          if (performance.now() > deadline)
            throw new Error(
              "observed control assertion failed after bounded read-only reconciliation",
            );
          await Bun.sleep(100);
        }
      }
      if (performance.now() - captureDispatch > (seconds - 2) * 1000)
        throw new Error("action completed outside recording budget");
      await peer.rpc("status");
      const completion = {
        ...intent,
        receipt,
        startMs: start - actionStart,
        endMs: performance.now() - actionStart,
      };
      if (coordinationSeconds) {
        const completionSha256 = publish(root, `${prefix}-completion.json`, completion);
        await waitReply(
          join(root, `${prefix}-ack.json`),
          { intentId: intent.intentId, completionSha256, accepted: true },
          performance.now() + coordinationSeconds * 1000,
          checkCoordination,
        );
      }
      actionIndex++;
      actionReceipts.push({
        action,
        startMs: start - actionStart,
        endMs: performance.now() - actionStart,
        receipt,
      });
      save();
    }
    await Bun.sleep(500);
    await verify();
    await pageIdentity();
    await peer.rpc("status");
    if (performance.now() - captureDispatch > (seconds - 1) * 1000)
      throw new Error("final tail exceeded recording budget");
    manifest.captureStop = await peer.rpc("stop");
    publish(root, "browser-capture-stopped.json", {
      version: 1,
      session,
      pageId,
      captureStop: manifest.captureStop,
      utc: Date.now(),
    });
    manifest.stage = "copying";
    save();
    const video = join(root, "source.mp4");
    manifest.video = await peer.copy("video", video);
    await command(["ffmpeg", "-nostdin", "-v", "error", "-i", video, "-f", "null", "-"], 60000);
    const probe = JSON.parse(
      await command([
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "frame=best_effort_timestamp_time:stream=width,height,duration,nb_frames",
        "-of",
        "json",
        video,
      ]),
    );
    const pts = (probe.frames as { best_effort_timestamp_time: string }[]).map((f) =>
      Number(f.best_effort_timestamp_time),
    );
    if (
      pts.length < 2 ||
      pts.some((t, i) => !Number.isFinite(t) || (i > 0 && t <= (pts[i - 1] as number)))
    )
      throw new Error("invalid source timestamps");
    write("source-probe.json", probe);
    let firstStable: { frame: number; pts: number; score: number } | undefined;
    for (const frame of [0, 4, 8, 12, 15]) {
      if (frame >= pts.length) break;
      const image = join(root, `decoded-${frame}.png`);
      await command(
        [
          "ffmpeg",
          "-nostdin",
          "-v",
          "error",
          "-i",
          video,
          "-vf",
          `select=eq(n\\,${frame})`,
          "-frames:v",
          "1",
          image,
        ],
        10000,
      );
      const score = await similarity(image, manifest.referenceFrame as string);
      if (score >= 0.98) {
        firstStable = { frame, pts: pts[frame] as number, score };
        break;
      }
    }
    if (!firstStable || firstStable.pts > 1) throw new Error("decoded stable lead-in not proven");
    manifest.firstVerifiedStableFrame = firstStable;
    manifest.stage = "verified-copy";
    save();
    clearInterval(monitor);
    peer.revoke();
    await releaseOwned();
    if (await farm.sessions.read(session)) throw new Error("lease release not confirmed");
    manifest.status = "fixture-verified";
    manifest.stage = "released";
    manifest.limitations = [
      "No Studio or phone acceptance",
      "15fps native display capture",
      "First verified stable PTS excludes earlier startup frames",
      "Shared-event synchronization still required; no per-action retiming",
      "Actual native hover precedes agent-browser click/fill",
    ];
    save();
    console.log(JSON.stringify({ status: manifest.status, output: root, video }));
  } catch (error) {
    safety.trip(error);
    manifest.status = "pending";
    manifest.error = String(error);
    publish(root, "helper-failure.json", {
      version: 1,
      session,
      pageId,
      error: String(error),
      stage: manifest.stage,
      utc: Date.now(),
    });
    save();
    clearInterval(monitor);
    peer?.revoke();
    // Preserve the exact lease if a source may need recovery; never destroy it before verified copy.
    if (!recording) {
      try {
        await releaseOwned();
        manifest.stage = "failed-before-recording-released";
      } catch (cleanup) {
        manifest.cleanupError = String(cleanup);
      }
    }
    save();
    throw error;
  } finally {
    clearInterval(monitor);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
if (import.meta.main)
  run().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
