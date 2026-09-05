import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DirectoryLockOptions, withDirectoryLock } from "../cli/directory-lock.ts";
import { CliError } from "../cli/errors.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function lockPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "agentbrowse-lock-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "state", "test.lock");
}

const QUICK: DirectoryLockOptions = {
  waitMs: 300,
  staleMs: 90_000,
  busy: () => new CliError("test_busy", "held"),
};

/** A lock directory left behind by some other holder, with the given owner file. */
async function plantLock(path: string, owner: string | null, ageMs = 0): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (owner !== null) await writeFile(join(path, "owner"), owner, { mode: 0o600 });
  if (ageMs > 0) {
    const then = (Date.now() - ageMs) / 1000;
    await utimes(path, then, then);
  }
}

/** A PID that certainly belonged to a process that has since exited. */
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  return child.pid;
}

test("the lock is held for the operation and released afterwards", async () => {
  const path = lockPath();
  let heldDuring = false;
  const result = await withDirectoryLock(path, QUICK, async () => {
    heldDuring = existsSync(join(path, "owner"));
    return "done";
  });
  expect(result).toBe("done");
  expect(heldDuring).toBe(true);
  expect(existsSync(path)).toBe(false);
});

test("the lock is released when the operation throws", async () => {
  const path = lockPath();
  await expect(
    withDirectoryLock(path, QUICK, async () => {
      throw new Error("operation failed");
    }),
  ).rejects.toThrow("operation failed");
  expect(existsSync(path)).toBe(false);
});

test("a live holder makes a contender wait, then report busy", async () => {
  const path = lockPath();
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holder = withDirectoryLock(path, QUICK, async () => {
    await released;
  });
  // Let the holder acquire before the contender starts.
  await Bun.sleep(20);
  const startedAt = Date.now();
  await expect(withDirectoryLock(path, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(QUICK.waitMs - 5);
  release();
  await holder;
  expect(existsSync(path)).toBe(false);
});

test("a lock whose recorded owner no longer exists is reclaimed at once", async () => {
  const path = lockPath();
  await plantLock(path, `${await deadPid()}\n`);
  const startedAt = Date.now();
  const result = await withDirectoryLock(path, QUICK, async () => "reclaimed");
  expect(result).toBe("reclaimed");
  // Well inside the wait: no age threshold was consulted.
  expect(Date.now() - startedAt).toBeLessThan(QUICK.waitMs);
  expect(existsSync(path)).toBe(false);
});

test("a fresh lock with a live owner is never reclaimed early", async () => {
  const path = lockPath();
  await plantLock(path, `${process.pid}\n`);
  await expect(withDirectoryLock(path, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });
  expect(existsSync(join(path, "owner"))).toBe(true);
});

test("an aged lock with a live owner is still held", async () => {
  const path = lockPath();
  await plantLock(path, `${process.pid}\n`, QUICK.staleMs * 2);
  await expect(withDirectoryLock(path, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });
  expect(existsSync(join(path, "owner"))).toBe(true);
});

test("a lock with no owner file keeps the age rule", async () => {
  const fresh = lockPath();
  await plantLock(fresh, null);
  await expect(withDirectoryLock(fresh, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });

  const aged = lockPath();
  await plantLock(aged, null, QUICK.staleMs * 2);
  expect(await withDirectoryLock(aged, QUICK, async () => "reclaimed")).toBe("reclaimed");
  expect(existsSync(aged)).toBe(false);
});

test("an unparsable owner file keeps the age rule", async () => {
  const fresh = lockPath();
  await plantLock(fresh, "not a pid\n");
  await expect(withDirectoryLock(fresh, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });

  const aged = lockPath();
  await plantLock(aged, "not a pid\n", QUICK.staleMs * 2);
  expect(await withDirectoryLock(aged, QUICK, async () => "reclaimed")).toBe("reclaimed");
});
