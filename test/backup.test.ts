import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupHostCommand, runBackup } from "../cli/backup.ts";
import type { BrowserFleet } from "../cli/fleet.ts";
import { renderTargetConfig, targetFor } from "../cli/model.ts";
import { ProfileBindingStore } from "../cli/profile-binding.ts";
import { ProviderSessions } from "../cli/sessions.ts";
import type { HypemanBackendConfig } from "../config/deployment.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-backup-test-"));
  temporaryDirectories.push(directory);
  const config = join(directory, "config.json");
  writeFileSync(
    config,
    JSON.stringify({
      version: 2,
      backends: [
        {
          id: "local",
          type: "hypeman",
          baseUrl: "http://127.0.0.1:4973",
          tokenFile: join(directory, "token"),
        },
        {
          id: "artbird",
          type: "hypeman",
          baseUrl: "http://192.0.2.4:4973",
          tokenFile: join(directory, "remote.token"),
          remoteHost: "artbird",
          networkAddress: "192.0.2.4",
        },
      ],
    }),
  );
  return {
    directory,
    env: {
      AGENTBROWSE_CONFIG: config,
      AGENTBROWSE_RUNTIME_DIR: join(directory, "runtime"),
      AGENTBROWSE_STATE_DIR: join(directory, "state"),
    },
  };
}

function writePreparedSession(directory: string, session: string, profile: string) {
  const sessions = join(directory, "state/provider-sessions");
  const receipt = {
    version: 1 as const,
    session,
    profile,
    persistent: false,
    lease: "a".repeat(32),
    createdAt: new Date(0).toISOString(),
    target: null,
  };
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, `${createHash("sha256").update(session).digest("hex")}.json`),
    `${JSON.stringify(receipt)}\n`,
  );
  return receipt;
}

function hostReport(backend: string, profileCount: number, multiplier: number) {
  const bytes = {
    reserved: 100 * multiplier,
    rawLogical: 80 * multiplier,
    physicalAllocated: 40 * multiplier,
    expectedCompressed: 20 * multiplier,
    compressionUncertainty: 5 * multiplier,
  };
  return {
    formatVersion: 1,
    backend,
    profileCount,
    reconciliationFindings: backend === "artbird" ? [{ severity: "error", code: "attached" }] : [],
    profiles: [],
    totals: { bytes, decimal: {}, binary: {} },
  };
}

function isHostCommand(command: readonly string[], name: string): boolean {
  return command.includes(name) || command.join(" ").includes(`'${name}'`);
}

test("backup host commands preserve the local root and use the installed remote helper", () => {
  const local = {
    id: "local",
    remoteHost: null,
    tokenFile: "/private/host/token",
  } as HypemanBackendConfig;
  expect(backupHostCommand(local, ["measure"])).toEqual([
    "python3",
    "/private/host/host/profile-backup.py",
    "--root",
    "/private/host",
    "--helper",
    "/private/host/host/agentbrowse-hypeman",
    "--backend",
    "local",
    "measure",
  ]);
  const remote = { ...local, id: "artbird", remoteHost: "artbird" };
  const command = backupHostCommand(remote, ["inspect", "--set", "/backups/one"]);
  expect(command.slice(0, 6)).toEqual([
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "artbird",
  ]);
  expect(command[6]).toContain("'/usr/local/lib/agentbrowse/profile-backup.py'");
  expect(command[6]).toContain("'/backups/one'");
  const quoted = backupHostCommand(remote, ["inspect", "--set", "/tmp/a'$(touch nope)"])[6]!;
  expect(quoted).toContain(`'/tmp/a'"'"'$(touch nope)'`);
});

test("fleet measurement aggregates every configured backend and retains findings", async () => {
  const { env } = fixture();
  const commands: string[][] = [];
  const result = await runBackup(
    {
      command: "backup",
      action: "measure",
      all: true,
      compressionEstimate: true,
      json: true,
    },
    env,
    async (command) => {
      commands.push([...command]);
      const backend = command[0] === "ssh" ? "artbird" : "local";
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          hostReport(backend, backend === "local" ? 1 : 2, backend === "local" ? 1 : 2),
        ),
        stderr: "",
      };
    },
  );
  expect(commands).toHaveLength(2);
  expect(commands.every((command) => command.join(" ").includes("--compression-estimate"))).toBe(
    true,
  );
  expect(result.profileCount).toBe(3);
  expect(result.reconciliationFindings).toEqual([
    { backend: "artbird", finding: { severity: "error", code: "attached" } },
  ]);
  expect((result.totals as { bytes: Record<string, number> }).bytes).toEqual({
    reserved: 300,
    rawLogical: 240,
    physicalAllocated: 120,
    expectedCompressed: 60,
    compressionUncertainty: 15,
  });
  expect(
    (result.totals as { binary: Record<string, { bytes: number }> }).binary.reserved!.bytes,
  ).toBe(300);
});

test("create forwards age recipients and dry-run without interpreting host paths", async () => {
  const { env } = fixture();
  let observed: readonly string[] = [];
  const result = await runBackup(
    {
      command: "backup",
      action: "create",
      backend: "artbird",
      destination: "/mnt/private backup/2026-09-18",
      recipients: ["age1first", "age1second"],
      unencrypted: false,
      dryRun: true,
      json: true,
    },
    env,
    async (command) => {
      observed = command;
      return {
        exitCode: 0,
        stdout: '{"complete":false,"dryRun":true}',
        stderr: "",
      };
    },
  );
  expect(observed[6]).toContain("'/mnt/private backup/2026-09-18'");
  expect(observed[6]!.match(/'--recipient'/g)).toHaveLength(2);
  expect(observed[6]).toContain("'--dry-run'");
  expect(result).toEqual({ complete: false, dryRun: true });
});

test("successful restore writes new logical backend bindings without runtime identity", async () => {
  const { directory, env } = fixture();
  const result = await runBackup(
    {
      command: "backup",
      action: "restore",
      backend: "local",
      set: "/backups/set-1",
      identity: "/keys/backup.agekey",
      allowUnencrypted: false,
      expectedSetDigest: "a".repeat(64),
      releaseReservations: false,
      dryRun: false,
      json: true,
    },
    env,
    async (command) =>
      isHostCommand(command, "inspect")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              setDigest: "a".repeat(64),
              profiles: [{ profile: "research" }],
            }),
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: '{"complete":["research"],"newVolumeIds":true}',
            stderr: "",
          },
  );
  expect(result.bindingsCreated).toEqual(["research"]);
  const binding = JSON.parse(readFileSync(join(directory, "state/profiles/research.json"), "utf8"));
  expect(binding).toMatchObject({
    profile: "research",
    backend: "local",
    target: null,
  });
  expect(binding).not.toHaveProperty("slot");
  expect(binding).not.toHaveProperty("lease");
});

test("restore reserves all logical names before host mutation and retains them for retry", async () => {
  const { directory, env } = fixture();
  let calls = 0;
  await expect(
    runBackup(
      {
        command: "backup",
        action: "restore",
        backend: "local",
        set: "/backups/plain",
        allowUnencrypted: true,
        expectedSetDigest: "b".repeat(64),
        releaseReservations: false,
        dryRun: false,
        json: true,
      },
      env,
      async (command) => {
        calls += 1;
        if (command.includes("inspect"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              setDigest: "b".repeat(64),
              profiles: [{ profile: "alpha" }, { profile: "beta" }],
            }),
            stderr: "",
          };
        for (const profile of ["alpha", "beta"]) {
          const receipt = JSON.parse(
            readFileSync(join(directory, `state/profiles/${profile}.json`), "utf8"),
          );
          expect(receipt.pendingRestore).toBe("b".repeat(64));
        }
        return { exitCode: 1, stdout: "", stderr: "synthetic interruption" };
      },
    ),
  ).rejects.toThrow("synthetic interruption");
  expect(calls).toBe(2);
  expect(
    JSON.parse(readFileSync(join(directory, "state/profiles/alpha.json"), "utf8")).pendingRestore,
  ).toBe("b".repeat(64));

  const released = await runBackup(
    {
      command: "backup",
      action: "restore",
      backend: "local",
      set: "/backups/plain",
      allowUnencrypted: true,
      expectedSetDigest: "b".repeat(64),
      releaseReservations: true,
      dryRun: false,
      json: true,
    },
    env,
    async (command) =>
      isHostCommand(command, "inspect")
        ? {
            exitCode: 0,
            stdout: JSON.stringify({
              setDigest: "b".repeat(64),
              profiles: [{ profile: "alpha" }, { profile: "beta" }],
            }),
            stderr: "",
          }
        : {
            exitCode: 0,
            stdout: JSON.stringify({ released: ["alpha", "beta"] }),
            stderr: "",
          },
  );
  expect(released.bindingsReleased).toEqual(["alpha", "beta"]);
  expect(existsSync(join(directory, "state/profiles/alpha.json"))).toBe(false);
});

test("restore refuses a profile held only by a prepared provider session before host mutation", async () => {
  const { directory, env } = fixture();
  const session = "prepared-disposable";
  writePreparedSession(directory, session, "research");
  let hostMutations = 0;

  await expect(
    runBackup(
      {
        command: "backup",
        action: "restore",
        backend: "local",
        set: "/backups/plain",
        allowUnencrypted: true,
        expectedSetDigest: "e".repeat(64),
        releaseReservations: false,
        dryRun: false,
        json: true,
      },
      env,
      async (command) => {
        if (command.includes("inspect"))
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              setDigest: "e".repeat(64),
              profiles: [{ profile: "research" }],
            }),
            stderr: "",
          };
        hostMutations += 1;
        return { exitCode: 0, stdout: '{"complete":["research"]}', stderr: "" };
      },
    ),
  ).rejects.toMatchObject({ code: "profile_leased" });
  expect(hostMutations).toBe(0);
  expect(existsSync(join(directory, "state/profiles/research.json"))).toBe(false);
  expect(existsSync(join(directory, `state/restore-operations/${"e".repeat(64)}.json`))).toBe(
    false,
  );
});

test("stale disposable cleanup preserves a pending reservation and unwedges restore retry", async () => {
  const { directory, env } = fixture();
  const state = join(directory, "state");
  const digest = "6".repeat(64);
  const bindings = new ProfileBindingStore(state);
  await bindings.reserveRestore(["research"], "local", digest);
  const receipt = writePreparedSession(directory, "legacy-pending-retry", "research");
  const sessions = new ProviderSessions({ bindings } as BrowserFleet, state);
  let hostMutations = 0;
  const parsed = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "local",
    set: "/backups/plain",
    allowUnencrypted: true,
    expectedSetDigest: digest,
    releaseReservations: false,
    dryRun: false,
    json: true,
  };
  const runner = async (command: readonly string[]) => {
    if (command.includes("inspect"))
      return {
        exitCode: 0,
        stdout: JSON.stringify({ setDigest: digest, profiles: [{ profile: "research" }] }),
        stderr: "",
      };
    hostMutations += 1;
    return { exitCode: 0, stdout: '{"complete":["research"]}', stderr: "" };
  };

  await expect(runBackup(parsed, env, runner)).rejects.toMatchObject({ code: "profile_leased" });
  expect(hostMutations).toBe(0);
  await expect(sessions.launch(receipt.session)).rejects.toMatchObject({
    code: "session_profile_changed",
    recovery: expect.stringContaining("restore reservation"),
  });
  expect(await sessions.release(receipt.session, receipt.lease)).toEqual({
    released: true,
    profile: "research",
    preserved: true,
  });
  expect(await bindings.read("research")).toMatchObject({ pendingRestore: digest });

  const restored = await runBackup(parsed, env, runner);
  expect(restored.bindingsCreated).toEqual(["research"]);
  expect(hostMutations).toBe(1);
  expect(await bindings.read("research")).toMatchObject({ restoredFrom: digest });
});

test("stale disposable cleanup unwedges explicit reservation release", async () => {
  const { directory, env } = fixture();
  const state = join(directory, "state");
  const digest = "7".repeat(64);
  const bindings = new ProfileBindingStore(state);
  await bindings.reserveRestore(["research"], "local", digest);
  const receipt = writePreparedSession(directory, "legacy-pending-release", "research");
  const sessions = new ProviderSessions({ bindings } as BrowserFleet, state);
  let hostMutations = 0;
  const parsed = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "local",
    set: "/backups/plain",
    allowUnencrypted: true,
    expectedSetDigest: digest,
    releaseReservations: true,
    dryRun: false,
    json: true,
  };
  const runner = async (command: readonly string[]) => {
    if (command.includes("inspect"))
      return {
        exitCode: 0,
        stdout: JSON.stringify({ setDigest: digest, profiles: [{ profile: "research" }] }),
        stderr: "",
      };
    hostMutations += 1;
    return { exitCode: 0, stdout: '{"released":["research"]}', stderr: "" };
  };

  await expect(runBackup(parsed, env, runner)).rejects.toMatchObject({ code: "profile_leased" });
  expect(hostMutations).toBe(0);
  await sessions.release(receipt.session, receipt.lease);
  expect(await bindings.read("research")).toMatchObject({ pendingRestore: digest });

  const released = await runBackup(parsed, env, runner);
  expect(released.bindingsReleased).toEqual(["research"]);
  expect(hostMutations).toBe(1);
  expect(await bindings.read("research")).toBeUndefined();
  expect(existsSync(join(state, `restore-operations/${digest}.json`))).toBe(false);
});

test("restore binding finalization resumes from a digest-bound operation journal", async () => {
  const { directory, env } = fixture();
  const digest = "c".repeat(64);
  const store = new ProfileBindingStore(join(directory, "state"));
  await store.reserveRestore(["alpha", "beta"], "local", digest);

  const alphaPath = join(directory, "state/profiles/alpha.json");
  const alpha = JSON.parse(readFileSync(alphaPath, "utf8"));
  delete alpha.pendingRestore;
  alpha.restoredFrom = digest;
  writeFileSync(alphaPath, `${JSON.stringify(alpha, null, 2)}\n`);
  const journalPath = join(directory, `state/restore-operations/${digest}.json`);
  const journal = JSON.parse(readFileSync(journalPath, "utf8"));
  journal.completed = ["alpha"];
  writeFileSync(journalPath, `${JSON.stringify(journal, null, 2)}\n`);

  await store.reserveRestore(["alpha", "beta"], "local", digest);
  await store.completeRestore(["alpha", "beta"], "local", digest);
  expect(await store.read("alpha")).toMatchObject({ restoredFrom: digest, target: null });
  expect(await store.read("beta")).toMatchObject({ restoredFrom: digest, target: null });
  expect(JSON.parse(readFileSync(journalPath, "utf8")).completed).toEqual(["alpha", "beta"]);
  expect(env.AGENTBROWSE_STATE_DIR).toBe(join(directory, "state"));
});

test("restore reconciliation plans exact cross-namespace ownership and preserves unrelated bindings", async () => {
  const { directory, env } = fixture();
  const digest = "1".repeat(64);
  const main = new ProfileBindingStore(join(directory, "state"));
  const demoState = join(directory, "demo-state");
  const demo = new ProfileBindingStore(demoState);
  const profiles = Array.from(
    { length: 24 },
    (_, index) => `current-${String(index).padStart(2, "0")}`,
  );
  for (const profile of profiles.slice(0, 23)) await main.bindProfile(profile, "artbird");
  for (let index = 0; index < 15; index += 1)
    await main.bindProfile(`local-${String(index).padStart(2, "0")}`, "local");
  const target = targetFor("demo-current", 91, {
    profile: profiles[23]!,
    backend: "artbird",
    container: "old-demo-current",
  });
  await demo.bindTarget(target);
  await demo.bindProfile("legacy-demo", "hypeman-artbird");
  mkdirSync(env.AGENTBROWSE_RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(env.AGENTBROWSE_RUNTIME_DIR, `${target.name}.json`),
    renderTargetConfig(target),
  );

  const parsed = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    releaseReservations: false,
    reconcileFromBackend: "artbird",
    bindingStateDirs: [demoState],
    dryRun: true,
    json: true,
  };
  const runner: Parameters<typeof runBackup>[2] = async (command) => ({
    exitCode: 0,
    stdout: JSON.stringify(
      isHostCommand(command, "inspect")
        ? {
            setDigest: digest,
            sourceBackend: "artbird",
            profiles: profiles.map((profile) => ({ profile })),
          }
        : { complete: profiles, dryRun: true },
    ),
    stderr: "",
  });

  const first = await runBackup(parsed, env, runner);
  const second = await runBackup(parsed, env, runner);
  const plan = first.bindingReconciliation as {
    reconciliationDigest: string;
    namespaces: { stateDir: string; profiles: { owner: boolean; binding: unknown }[] }[];
  };
  expect(plan.reconciliationDigest).toBe(
    (second.bindingReconciliation as { reconciliationDigest: string }).reconciliationDigest,
  );
  expect(plan.namespaces).toHaveLength(2);
  expect(plan.namespaces[0]!.profiles.filter((entry) => entry.owner)).toHaveLength(23);
  expect(plan.namespaces[1]!.profiles.filter((entry) => entry.owner)).toHaveLength(1);
  expect(plan.namespaces[1]!.profiles.find((entry) => entry.owner)?.binding).not.toBeNull();
  expect(await demo.read("legacy-demo")).toMatchObject({ backend: "hypeman-artbird" });
  for (let index = 0; index < 15; index += 1)
    expect(await main.read(`local-${String(index).padStart(2, "0")}`)).toMatchObject({
      backend: "local",
    });
  expect(existsSync(join(directory, "state/restore-reconciliations"))).toBe(false);

  const config = JSON.parse(readFileSync(env.AGENTBROWSE_CONFIG, "utf8"));
  config.backends.push({
    id: "hypeman-artbird",
    type: "hypeman",
    baseUrl: "http://192.0.2.5:4973",
    tokenFile: join(directory, "legacy-remote.token"),
    remoteHost: "artbird",
    networkAddress: "192.0.2.5",
  });
  writeFileSync(env.AGENTBROWSE_CONFIG, JSON.stringify(config));
  const legacyDigest = "7".repeat(64);
  const legacy = await runBackup(
    {
      ...parsed,
      backend: "hypeman-artbird",
      set: "/backups/legacy",
      expectedSetDigest: legacyDigest,
      reconcileFromBackend: "hypeman-artbird",
    },
    env,
    async (command) => ({
      exitCode: 0,
      stdout: JSON.stringify(
        isHostCommand(command, "inspect")
          ? {
              setDigest: legacyDigest,
              sourceBackend: "hypeman-artbird",
              profiles: [{ profile: "legacy-demo" }],
            }
          : { complete: ["legacy-demo"], dryRun: true },
      ),
      stderr: "",
    }),
  );
  const legacyPlan = legacy.bindingReconciliation as {
    namespaces: { profiles: { owner: boolean; binding: { backend: string } | null }[] }[];
  };
  expect(legacyPlan.namespaces[0]!.profiles.filter((entry) => entry.owner)).toHaveLength(0);
  expect(legacyPlan.namespaces[1]!.profiles).toEqual([
    expect.objectContaining({
      owner: true,
      binding: expect.objectContaining({ backend: "hypeman-artbird" }),
    }),
  ]);
});

test("restore reconciliation archives exact collisions and keeps bindings in their namespaces", async () => {
  const { directory, env } = fixture();
  const digest = "2".repeat(64);
  const main = new ProfileBindingStore(join(directory, "state"));
  const demoState = join(directory, "demo-state");
  const demo = new ProfileBindingStore(demoState);
  const profiles = ["alpha", "beta", "demo-current"];
  await main.bindProfile("alpha", "artbird");
  await main.bindProfile("beta", "artbird");
  await main.bindProfile("unrelated-local", "local");
  const target = targetFor("demo-target", 77, {
    profile: "demo-current",
    backend: "artbird",
    container: "old-demo-container",
  });
  await demo.bindTarget(target);
  mkdirSync(env.AGENTBROWSE_RUNTIME_DIR, { recursive: true });
  writeFileSync(
    join(env.AGENTBROWSE_RUNTIME_DIR, `${target.name}.json`),
    renderTargetConfig(target),
  );
  const base = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    releaseReservations: false,
    reconcileFromBackend: "artbird",
    bindingStateDirs: [demoState],
    json: true,
  };
  const runner: Parameters<typeof runBackup>[2] = async (command) => ({
    exitCode: 0,
    stdout: JSON.stringify(
      isHostCommand(command, "inspect")
        ? {
            setDigest: digest,
            sourceBackend: "artbird",
            profiles: profiles.map((profile) => ({ profile })),
          }
        : { complete: profiles, newVolumeIds: true },
    ),
    stderr: "",
  });
  const dry = await runBackup({ ...base, dryRun: true }, env, runner);
  const reconciliationDigest = (dry.bindingReconciliation as { reconciliationDigest: string })
    .reconciliationDigest;
  const result = await runBackup(
    { ...base, dryRun: false, expectedReconciliationDigest: reconciliationDigest },
    env,
    runner,
  );

  expect(result.bindingsCreated).toEqual(profiles);
  expect(await main.read("alpha")).toMatchObject({ backend: "artbird", restoredFrom: digest });
  expect(await main.read("beta")).toMatchObject({ backend: "artbird", restoredFrom: digest });
  expect(await demo.read("demo-current")).toMatchObject({
    backend: "artbird",
    restoredFrom: digest,
    target: null,
  });
  expect(await main.read("unrelated-local")).toMatchObject({ backend: "local" });
  expect(
    existsSync(
      join(
        demoState,
        "retired-bindings/restore-reconciliations",
        digest,
        "targets/demo-target.json",
      ),
    ),
  ).toBe(true);
  expect(existsSync(join(env.AGENTBROWSE_RUNTIME_DIR, "demo-target.json"))).toBe(false);
});

test("restore reconciliation refuses a provider-session receipt created after the dry-run", async () => {
  const { directory, env } = fixture();
  const digest = "3".repeat(64);
  const store = new ProfileBindingStore(join(directory, "state"));
  await store.bindProfile("research", "artbird");
  const parsed = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    releaseReservations: false,
    reconcileFromBackend: "artbird",
    json: true,
  };
  const report = JSON.stringify({
    setDigest: digest,
    sourceBackend: "artbird",
    profiles: [{ profile: "research" }],
  });
  const dry = await runBackup({ ...parsed, dryRun: true }, env, async (command) => ({
    exitCode: 0,
    stdout: isHostCommand(command, "inspect") ? report : '{"dryRun":true}',
    stderr: "",
  }));
  const expectedReconciliationDigest = (
    dry.bindingReconciliation as { reconciliationDigest: string }
  ).reconciliationDigest;
  const receipt = writePreparedSession(directory, "active-research", "research");
  let hostRestoreCalls = 0;
  await expect(
    runBackup({ ...parsed, dryRun: false, expectedReconciliationDigest }, env, async (command) => {
      if (!isHostCommand(command, "inspect")) hostRestoreCalls += 1;
      return { exitCode: 0, stdout: report, stderr: "" };
    }),
  ).rejects.toMatchObject({ code: "profile_leased" });
  expect(hostRestoreCalls).toBe(0);
  expect(await store.read("research")).toMatchObject({ backend: "artbird", target: null });
  expect(
    JSON.parse(
      readFileSync(
        join(
          directory,
          "state/provider-sessions",
          `${createHash("sha256").update(receipt.session).digest("hex")}.json`,
        ),
        "utf8",
      ),
    ),
  ).toMatchObject({ lease: receipt.lease, profile: "research" });
});

test("restore reconciliation refuses a changed binding revision before host mutation", async () => {
  const { directory, env } = fixture();
  const digest = "5".repeat(64);
  const store = new ProfileBindingStore(join(directory, "state"));
  await store.bindProfile("research", "artbird");
  const parsed = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    releaseReservations: false,
    reconcileFromBackend: "artbird",
    json: true,
  };
  const report = JSON.stringify({
    setDigest: digest,
    sourceBackend: "artbird",
    profiles: [{ profile: "research" }],
  });
  const dry = await runBackup({ ...parsed, dryRun: true }, env, async (command) => ({
    exitCode: 0,
    stdout: isHostCommand(command, "inspect") ? report : '{"dryRun":true}',
    stderr: "",
  }));
  const expectedReconciliationDigest = (
    dry.bindingReconciliation as { reconciliationDigest: string }
  ).reconciliationDigest;
  await store.bindTarget(
    targetFor("changed-target", 44, {
      profile: "research",
      backend: "artbird",
      container: "changed-container",
    }),
  );
  let hostRestoreCalls = 0;
  await expect(
    runBackup({ ...parsed, dryRun: false, expectedReconciliationDigest }, env, async (command) => {
      if (!isHostCommand(command, "inspect")) hostRestoreCalls += 1;
      return { exitCode: 0, stdout: report, stderr: "" };
    }),
  ).rejects.toMatchObject({ code: "profile_backup_failed" });
  expect(hostRestoreCalls).toBe(0);
  expect(await store.read("research")).toMatchObject({
    target: { name: "changed-target", container: "changed-container" },
  });
  expect(existsSync(join(directory, "state/restore-reconciliations"))).toBe(false);
});

test("restore reconciliation resumes after host failure and a completed re-run is a no-op", async () => {
  const { directory, env } = fixture();
  const digest = "4".repeat(64);
  const store = new ProfileBindingStore(join(directory, "state"));
  await store.bindProfile("research", "artbird");
  const base = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    releaseReservations: false,
    reconcileFromBackend: "artbird",
    json: true,
  };
  const report = JSON.stringify({
    setDigest: digest,
    sourceBackend: "artbird",
    profiles: [{ profile: "research" }],
  });
  const dry = await runBackup({ ...base, dryRun: true }, env, async (command) => ({
    exitCode: 0,
    stdout: isHostCommand(command, "inspect") ? report : '{"dryRun":true}',
    stderr: "",
  }));
  const expectedReconciliationDigest = (
    dry.bindingReconciliation as { reconciliationDigest: string }
  ).reconciliationDigest;
  await expect(
    runBackup({ ...base, dryRun: false, expectedReconciliationDigest }, env, async (command) =>
      isHostCommand(command, "inspect")
        ? { exitCode: 0, stdout: report, stderr: "" }
        : { exitCode: 1, stdout: "", stderr: "synthetic host interruption" },
    ),
  ).rejects.toMatchObject({ code: "profile_backup_failed" });
  expect(await store.read("research")).toMatchObject({ pendingRestore: digest });

  const successfulRunner: Parameters<typeof runBackup>[2] = async (command) =>
    isHostCommand(command, "inspect")
      ? { exitCode: 0, stdout: report, stderr: "" }
      : { exitCode: 0, stdout: '{"complete":["research"]}', stderr: "" };
  await runBackup({ ...base, dryRun: false, expectedReconciliationDigest }, env, successfulRunner);
  const archived = join(
    directory,
    "state/retired-bindings/restore-reconciliations",
    digest,
    "profiles/research.json",
  );
  const archivedSource = readFileSync(archived, "utf8");
  expect(await store.read("research")).toMatchObject({ restoredFrom: digest });

  await runBackup({ ...base, dryRun: false, expectedReconciliationDigest }, env, successfulRunner);
  expect(readFileSync(archived, "utf8")).toBe(archivedSource);
  expect(await store.read("research")).toMatchObject({ restoredFrom: digest });
});

test("reconciled restore reservation release retains archived history and is idempotent", async () => {
  const { directory, env } = fixture();
  const digest = "6".repeat(64);
  const store = new ProfileBindingStore(join(directory, "state"));
  await store.bindProfile("research", "artbird");
  const base = {
    command: "backup" as const,
    action: "restore" as const,
    backend: "artbird",
    set: "/backups/current",
    identity: "/keys/current.agekey",
    allowUnencrypted: false,
    expectedSetDigest: digest,
    reconcileFromBackend: "artbird",
    json: true,
  };
  const report = JSON.stringify({
    setDigest: digest,
    sourceBackend: "artbird",
    profiles: [{ profile: "research" }],
  });
  const dry = await runBackup(
    { ...base, releaseReservations: false, dryRun: true },
    env,
    async (command) => ({
      exitCode: 0,
      stdout: isHostCommand(command, "inspect") ? report : '{"dryRun":true}',
      stderr: "",
    }),
  );
  const expectedReconciliationDigest = (
    dry.bindingReconciliation as { reconciliationDigest: string }
  ).reconciliationDigest;
  await expect(
    runBackup(
      {
        ...base,
        releaseReservations: false,
        dryRun: false,
        expectedReconciliationDigest,
      },
      env,
      async (command) =>
        isHostCommand(command, "inspect")
          ? { exitCode: 0, stdout: report, stderr: "" }
          : { exitCode: 1, stdout: "", stderr: "synthetic host interruption" },
    ),
  ).rejects.toMatchObject({ code: "profile_backup_failed" });

  const release = {
    ...base,
    releaseReservations: true,
    dryRun: false,
    expectedReconciliationDigest,
  };
  const releaseRunner: Parameters<typeof runBackup>[2] = async (command) =>
    isHostCommand(command, "inspect")
      ? { exitCode: 0, stdout: report, stderr: "" }
      : { exitCode: 0, stdout: '{"released":["research"]}', stderr: "" };
  await runBackup(release, env, releaseRunner);
  await runBackup(release, env, releaseRunner);
  expect(await store.read("research")).toBeUndefined();
  expect(
    existsSync(
      join(
        directory,
        "state/retired-bindings/restore-reconciliations",
        digest,
        "profiles/research.json",
      ),
    ),
  ).toBe(true);
  expect(
    JSON.parse(
      readFileSync(join(directory, "state/restore-reconciliations", `${digest}.json`), "utf8"),
    ),
  ).toMatchObject({ status: "released" });
});
