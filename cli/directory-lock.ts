/**
 * One filesystem lock, shared by the allocation lock in `farm.ts` and the
 * per-profile binding lock in `profile-binding.ts`.
 *
 * It is Lamport's bakery on a directory. A contender first creates a
 * uniquely named `p-<id>` file, which says it is choosing a number; it then
 * takes one more than the highest numbered ticket present and renames its
 * file to `t-<number>-<id>`. The lock is held by the lowest live ticket once
 * nobody is still choosing. Every file name is unique for all time, so a
 * holder releases by unlinking its own name and stale cleanup unlinks an
 * exact name it has inspected; nothing here ever removes a path that another
 * process may just have recreated, which is the flaw a single shared lock
 * file cannot escape without a compare-and-swap the filesystem does not
 * offer.
 *
 * Stale cleanup exists for a holder or chooser that died without releasing,
 * which is what happens when agent-browser kills a slow `agentbrowse
 * provider` on its own timeout. It is deliberately asymmetric. A file naming
 * a PID that no longer exists is proof its owner is gone and is removed at
 * once; without that, every launch and close would fail as busy until an age
 * threshold passed. An unparsable file keeps the age rule, because there is
 * no PID to check. A PID that still answers `kill(pid, 0)` is treated as
 * live until an absolute bound, since the number may have been reused after
 * a reboot and no lifecycle operation legitimately holds a lock for an hour.
 * Ordering comes from the numbers, not from any clock: Bun's monotonic time
 * is relative to the process, and the wall clock may step.
 */

import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CliError } from "./errors.ts";

export interface DirectoryLockOptions {
  /** How long a contender waits for a held lock before reporting busy. */
  readonly waitMs: number;
  /** Age after which a ticket whose owner cannot be checked is removed. */
  readonly staleMs: number;
  /** The refusal reported when the wait expires. */
  readonly busy: () => CliError;
}

/**
 * Past this age a ticket is removed even from an owner that still answers:
 * a PID reused after a reboot would otherwise hold the lock forever, and the
 * operations these locks cover finish in seconds.
 */
export const MAX_HOLD_MS = 60 * 60 * 1000;

const POLL_MS = 50;
const NUMBER_WIDTH = 10;
const TICKET = /^t-(\d{10})-[0-9a-f-]{36}$/;
const CHOOSING = /^p-[0-9a-f-]{36}$/;

type Liveness = "alive" | "dead" | "unknown";
type Standing = "held" | "waiting" | "lost";

export async function withDirectoryLock<T>(
  path: string,
  options: DirectoryLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await chmod(parent, 0o700);
  const ticket = await acquire(path, options);
  try {
    return await operation();
  } finally {
    await release(path, ticket);
  }
}

async function acquire(path: string, options: DirectoryLockOptions): Promise<string> {
  const deadline = Date.now() + options.waitMs;
  let ticket = await takeNumber(path);
  try {
    while (true) {
      const standing = await examine(path, ticket, options.staleMs);
      if (standing === "held") return ticket;
      if (standing === "lost") {
        // A peer judged this ticket stale, which only a misread PID or the
        // absolute bound can cause. Queue again rather than spin ticketless.
        ticket = await takeNumber(path);
        continue;
      }
      if (Date.now() >= deadline) throw options.busy();
      await Bun.sleep(POLL_MS);
    }
  } catch (error) {
    await unlinkQuietly(join(path, ticket));
    throw error;
  }
}

/** Create a choosing file, pick the next number, and turn it into a ticket. */
async function takeNumber(path: string): Promise<string> {
  const id = crypto.randomUUID();
  const choosing = `p-${id}`;
  await createEntry(path, choosing);
  try {
    let highest = 0;
    for (const name of await entries(path)) {
      const match = TICKET.exec(name);
      if (match !== null) highest = Math.max(highest, Number(match[1]));
    }
    const ticket = `t-${String(highest + 1).padStart(NUMBER_WIDTH, "0")}-${id}`;
    await rename(join(path, choosing), join(path, ticket));
    return ticket;
  } catch (error) {
    await unlinkQuietly(join(path, choosing));
    throw error;
  }
}

async function createEntry(path: string, name: string): Promise<void> {
  while (true) {
    await mkdir(path, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(path, name), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return;
    } catch (error) {
      // A releasing holder removed the emptied directory between the mkdir
      // and the create; make it again.
      if (errorCode(error) !== "ENOENT") throw error;
    }
  }
}

async function examine(path: string, mine: string, staleMs: number): Promise<Standing> {
  const names = await entries(path);
  // Someone still choosing may end up ahead of us; wait until it has a number.
  for (const name of names) {
    if (!CHOOSING.test(name)) continue;
    if (await isStale(join(path, name), staleMs)) {
      await unlinkQuietly(join(path, name));
      continue;
    }
    return "waiting";
  }
  // The lowest live ticket holds. Padded numbers make the string order the
  // numeric order, and the id breaks ties the same way for every contender.
  for (const name of names.filter((name) => TICKET.test(name)).sort()) {
    if (name === mine) return "held";
    if (await isStale(join(path, name), staleMs)) {
      await unlinkQuietly(join(path, name));
      continue;
    }
    return "waiting";
  }
  return "lost";
}

async function release(path: string, ticket: string): Promise<void> {
  await unlinkQuietly(join(path, ticket));
  try {
    // Best effort: a directory holding other contenders' files stays, and a
    // contender between its mkdir and its create simply makes it again.
    await rmdir(path);
  } catch (error) {
    const code = errorCode(error);
    if (code !== "ENOTEMPTY" && code !== "ENOENT" && code !== "EEXIST") throw error;
  }
}

async function isStale(file: string, staleMs: number): Promise<boolean> {
  let details: Awaited<ReturnType<typeof statBigInt>>;
  let source: string;
  try {
    details = await statBigInt(file);
    source = await readFile(file, "utf8");
  } catch (error) {
    // Already released or removed: nothing is ahead of us there any more.
    if (errorCode(error) === "ENOENT") return true;
    throw error;
  }
  const liveness = ownerLiveness(source);
  const ageMs = Date.now() - Number(details.mtimeMs);
  return liveness === "dead" || (liveness === "unknown" && ageMs > staleMs) || ageMs > MAX_HOLD_MS;
}

function ownerLiveness(source: string): Liveness {
  const match = /^([1-9][0-9]*)\n$/.exec(source);
  if (match === null) return "unknown";
  try {
    process.kill(Number(match[1]), 0);
    return "alive";
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; only ESRCH
    // proves there is no such process.
    return errorCode(error) === "ESRCH" ? "dead" : "alive";
  }
}

async function entries(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function unlinkQuietly(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

function statBigInt(path: string) {
  return stat(path, { bigint: true });
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}
