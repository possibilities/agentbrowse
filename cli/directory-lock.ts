/**
 * One mkdir-based lock, shared by the allocation lock in `farm.ts` and the
 * per-profile binding lock in `profile-binding.ts`.
 *
 * The lock is a directory: `mkdir` is atomic on every filesystem this runs on,
 * so whoever creates it holds it. The holder then records its PID in an
 * `owner` file so a later contender can tell an operation still in progress
 * from the residue of a process that died holding the lock — which is what
 * happens when agent-browser kills a slow `agentbrowse provider` on its own
 * timeout.
 *
 * Reclamation is deliberately asymmetric. An owner file naming a PID that no
 * longer exists is proof the holder is gone, and the lock is reclaimed at
 * once; without that, every launch and close would fail as busy until the
 * age threshold passed. Every other state keeps the age rule: a missing or
 * unparsable owner file may simply be the holder between `mkdir` and its
 * `writeFile`, and a PID that answers `kill(pid, 0)` may be a reused number,
 * so neither is reclaimed before `staleMs` has elapsed.
 */

import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { CliError } from "./errors.ts";

export interface DirectoryLockOptions {
  /** How long a contender waits for a held lock before reporting busy. */
  readonly waitMs: number;
  /** Age after which a lock whose owner cannot be shown alive is reclaimed. */
  readonly staleMs: number;
  /** The refusal reported when the wait expires. */
  readonly busy: () => CliError;
}

const POLL_MS = 50;

type OwnerLiveness = "alive" | "dead" | "unknown";

export async function withDirectoryLock<T>(
  path: string,
  options: DirectoryLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await acquire(path, options);
  try {
    return await operation();
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}

async function acquire(path: string, options: DirectoryLockOptions): Promise<void> {
  const deadline = Date.now() + options.waitMs;
  while (true) {
    if (await tryAcquire(path)) return;
    if (await reclaimIfStale(path, options.staleMs)) continue;
    if (Date.now() >= deadline) throw options.busy();
    await Bun.sleep(POLL_MS);
  }
}

async function tryAcquire(path: string): Promise<boolean> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return false;
  }
  try {
    await writeFile(join(path, "owner"), `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(path, { recursive: true, force: true });
    throw error;
  }
  return true;
}

/** True when the lock was removed and acquisition should be retried at once. */
async function reclaimIfStale(path: string, staleMs: number): Promise<boolean> {
  let details: Awaited<ReturnType<typeof stat>>;
  try {
    details = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const owner = await lockOwner(path);
  const aged = Date.now() - details.mtimeMs > staleMs;
  if (owner === "dead" || (aged && owner !== "alive")) {
    await rm(path, { recursive: true, force: true });
    return true;
  }
  return false;
}

async function lockOwner(path: string): Promise<OwnerLiveness> {
  let source: string;
  try {
    source = await readFile(join(path, "owner"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unknown";
    throw error;
  }
  if (!/^[1-9][0-9]*\n$/.test(source)) return "unknown";
  try {
    process.kill(Number(source.trim()), 0);
    return "alive";
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; only ESRCH
    // proves there is no such process.
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "alive";
  }
}
