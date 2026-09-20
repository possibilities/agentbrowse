import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { CliError } from "./errors.ts";

export interface ReceiptRevision {
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly generation: string;
  readonly changedNs: string;
  readonly size: string;
  readonly modifiedNs: string;
}

export interface OpenedReceipt {
  readonly source: string;
  readonly revision: ReceiptRevision;
}

export async function readReceipt(path: string): Promise<OpenedReceipt | undefined> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if ((error as NodeJS.ErrnoException).code === "ELOOP")
      throw invalidReceipt(`receipt is a symbolic link: ${path}`);
    throw error;
  }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile()) throw invalidReceipt(`receipt is not a regular file: ${path}`);
    const source = await file.readFile({ encoding: "utf8" });
    const after = await file.stat({ bigint: true });
    if (!sameOpenedStats(before, after))
      throw invalidReceipt(`receipt changed while reading: ${path}`);
    let pathDetails: BigIntStats;
    try {
      pathDetails = await lstat(path, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw invalidReceipt(`receipt path changed while reading: ${path}`);
      throw error;
    }
    if (pathDetails.isSymbolicLink() || !sameOpenedStats(after, pathDetails))
      throw invalidReceipt(`receipt path identity changed while reading: ${path}`);
    return { source, revision: receiptRevision(after, source) };
  } finally {
    await file.close();
  }
}

export function sameReceiptRevision(left: ReceiptRevision, right: ReceiptRevision): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.generation === right.generation &&
    left.changedNs === right.changedNs &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs
  );
}

export function sameReceiptLineage(left: ReceiptRevision, right: ReceiptRevision): boolean {
  return (
    left.sha256 === right.sha256 &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.generation === right.generation &&
    left.size === right.size &&
    left.modifiedNs === right.modifiedNs
  );
}

function receiptRevision(details: BigIntStats, source: string): ReceiptRevision {
  return {
    sha256: createHash("sha256").update(source).digest("hex"),
    device: details.dev.toString(),
    inode: details.ino.toString(),
    generation: details.birthtimeNs.toString(),
    changedNs: details.ctimeNs.toString(),
    size: details.size.toString(),
    modifiedNs: details.mtimeNs.toString(),
  };
}

function sameOpenedStats(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.birthtimeNs === right.birthtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    left.mtimeNs === right.mtimeNs &&
    left.size === right.size
  );
}

function invalidReceipt(message: string): CliError {
  return new CliError(
    "profile_backup_failed",
    message,
    "do not remove any receipt; repeat the dry-run and inspect the exact reconciliation evidence",
  );
}
