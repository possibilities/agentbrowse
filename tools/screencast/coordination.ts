import { createHash, randomBytes } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boundedDocument } from "./preparation.ts";

export function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function publish(root: string, name: string, value: unknown): string {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  writeFileSync(join(root, `${name}.tmp`), bytes, { mode: 0o600 });
  renameSync(join(root, `${name}.tmp`), join(root, name));
  return digest(bytes);
}
export function checkReply(bytes: Buffer, expected: Record<string, unknown>): void {
  const reply = JSON.parse(bytes.toString());
  if (!reply || Object.entries(expected).some(([key, value]) => reply[key] !== value))
    throw new Error("coordination reply rejected or does not match exact action bytes");
}
export async function waitReply(
  path: string,
  expected: Record<string, unknown>,
  deadline: number,
  check: () => Promise<void>,
): Promise<void> {
  while (true) {
    await check();
    if (performance.now() >= deadline) throw new Error("coordination deadline expired");
    try {
      checkReply(boundedDocument(path), expected);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await Bun.sleep(100);
  }
}
export function newIntent(
  identity: Record<string, unknown>,
  index: number,
  action: unknown,
): Record<string, unknown> {
  return { version: 1, ...identity, index, action, intentId: randomBytes(16).toString("hex") };
}
