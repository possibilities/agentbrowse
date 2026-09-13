import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export function preparationWindow(value: string | undefined): number {
  if (value === undefined) return 0;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 900)
    throw new Error("prepare-wait must be 60..900 seconds");
  return seconds;
}
export function boundedDocument(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      throw new Error("preparation document bound exceeded");
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > 1024 * 1024) throw new Error("preparation document grew beyond bound");
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}
export function acceptPreparation(
  readyBytes: Buffer,
  scriptBytes: Buffer,
  preparationId: string,
  identitySha256: string,
): unknown {
  const ready = JSON.parse(readyBytes.toString());
  const sha256 = createHash("sha256").update(scriptBytes).digest("hex");
  if (
    ready.preparationId !== preparationId ||
    ready.identitySha256 !== identitySha256 ||
    ready.scriptSha256 !== sha256
  )
    throw new Error("ready document does not match exact preparation identity and script bytes");
  // Return the verified bytes' parsed value, never reopen the producer's file.
  return JSON.parse(scriptBytes.toString());
}
