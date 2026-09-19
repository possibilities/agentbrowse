import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { backupHostCommand, runBackup } from "../cli/backup.ts";
import { ProfileBindingStore } from "../cli/profile-binding.ts";
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
      AGENTBROWSE_STATE_DIR: join(directory, "state"),
    },
  };
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
      command.includes("inspect")
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
      command.includes("inspect")
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
  const sessions = join(directory, "state/provider-sessions");
  mkdirSync(sessions, { recursive: true });
  writeFileSync(
    join(sessions, `${createHash("sha256").update(session).digest("hex")}.json`),
    `${JSON.stringify({
      version: 1,
      session,
      profile: "research",
      persistent: false,
      lease: "a".repeat(32),
      createdAt: new Date(0).toISOString(),
      target: null,
    })}\n`,
  );
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
