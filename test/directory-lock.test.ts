import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readdir, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type DirectoryLockOptions,
  MAX_HOLD_MS,
  withDirectoryLock,
} from "../cli/directory-lock.ts";
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

/** The lowest ticket number there is, so a planted ticket is ahead of any real one. */
function firstTicketName(): string {
  return `t-0000000001-${crypto.randomUUID()}`;
}

function choosingName(): string {
  return `p-${crypto.randomUUID()}`;
}

/** A lock file left behind by some other contender, aged through its mtime. */
async function plant(path: string, name: string, content: string, ageMs = 0): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const file = join(path, name);
  await writeFile(file, content, { mode: 0o600 });
  if (ageMs > 0) {
    const then = (Date.now() - ageMs) / 1000;
    await utimes(file, then, then);
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
  let ticketsDuring: string[] = [];
  const result = await withDirectoryLock(path, QUICK, async () => {
    ticketsDuring = await readdir(path);
    return "done";
  });
  expect(result).toBe("done");
  expect(ticketsDuring).toHaveLength(1);
  expect(ticketsDuring[0]).toMatch(/^t-0000000001-/);
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
  // The contender that gave up took its own ticket with it.
  expect(await readdir(path)).toHaveLength(1);
  release();
  await holder;
  expect(existsSync(path)).toBe(false);
});

test("a ticket whose recorded owner no longer exists is removed at once", async () => {
  const path = lockPath();
  await plant(path, firstTicketName(), `${await deadPid()}\n`);
  const startedAt = Date.now();
  const result = await withDirectoryLock(path, QUICK, async () => "reclaimed");
  expect(result).toBe("reclaimed");
  // Well inside the wait: no age threshold was consulted.
  expect(Date.now() - startedAt).toBeLessThan(QUICK.waitMs);
  expect(existsSync(path)).toBe(false);
});

test("a dead contender still choosing its number no longer blocks anyone", async () => {
  const path = lockPath();
  await plant(path, choosingName(), `${await deadPid()}\n`);
  expect(await withDirectoryLock(path, QUICK, async () => "reclaimed")).toBe("reclaimed");
  expect(existsSync(path)).toBe(false);
});

test("a live contender still choosing its number is waited for", async () => {
  const path = lockPath();
  const choosing = choosingName();
  await plant(path, choosing, `${process.pid}\n`);
  await expect(withDirectoryLock(path, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });
  expect(await readdir(path)).toEqual([choosing]);
});

test("a fresh ticket with a live owner is never removed early", async () => {
  const path = lockPath();
  const ticket = firstTicketName();
  await plant(path, ticket, `${process.pid}\n`);
  await expect(withDirectoryLock(path, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });
  expect(await readdir(path)).toEqual([ticket]);
});

test("an aged ticket with a live owner is held until the absolute bound", async () => {
  const aged = lockPath();
  await plant(aged, firstTicketName(), `${process.pid}\n`, QUICK.staleMs * 2);
  await expect(withDirectoryLock(aged, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });

  // A PID reused after a reboot answers kill(pid, 0) forever; the bound is
  // what stops such a ticket from reporting busy for the rest of time.
  const ancient = lockPath();
  await plant(ancient, firstTicketName(), `${process.pid}\n`, MAX_HOLD_MS + 1_000);
  expect(await withDirectoryLock(ancient, QUICK, async () => "reclaimed")).toBe("reclaimed");
});

test("an unparsable ticket keeps the age rule", async () => {
  const fresh = lockPath();
  await plant(fresh, firstTicketName(), "not a pid\n");
  await expect(withDirectoryLock(fresh, QUICK, async () => "never")).rejects.toMatchObject({
    code: "test_busy",
  });

  const aged = lockPath();
  await plant(aged, firstTicketName(), "not a pid\n", QUICK.staleMs * 2);
  expect(await withDirectoryLock(aged, QUICK, async () => "reclaimed")).toBe("reclaimed");
  expect(existsSync(aged)).toBe(false);
});

test("a directory holding no tickets is free", async () => {
  const path = lockPath();
  await mkdir(path, { recursive: true, mode: 0o700 });
  // A file from an older build's single-owner format is not a ticket.
  await writeFile(join(path, "owner"), `${process.pid}\n`);
  const startedAt = Date.now();
  expect(await withDirectoryLock(path, QUICK, async () => "claimed")).toBe("claimed");
  expect(Date.now() - startedAt).toBeLessThan(QUICK.waitMs);
});

test("contenders racing a dead holder never overlap", async () => {
  const options: DirectoryLockOptions = { ...QUICK, waitMs: 5_000 };
  let active = 0;
  let overlaps = 0;
  let completed = 0;
  for (let round = 0; round < 5; round += 1) {
    const path = lockPath();
    await plant(path, firstTicketName(), `${await deadPid()}\n`);
    await Promise.all(
      Array.from({ length: 8 }, () =>
        withDirectoryLock(path, options, async () => {
          active += 1;
          if (active !== 1) overlaps += 1;
          await Bun.sleep(5);
          active -= 1;
          completed += 1;
        }),
      ),
    );
    expect(existsSync(path)).toBe(false);
  }
  expect(overlaps).toBe(0);
  expect(completed).toBe(40);
});

test("a holder whose ticket was taken over leaves the new holder's ticket alone", async () => {
  const path = lockPath();
  const foreign = firstTicketName();
  await withDirectoryLock(path, QUICK, async () => {
    // Simulate a peer that judged this ticket stale and moved in: only this
    // holder's own name may go on release, never whatever is there now.
    for (const name of await readdir(path)) await unlink(join(path, name));
    await plant(path, foreign, `${process.pid}\n`);
  });
  expect(await readdir(path)).toEqual([foreign]);
});
