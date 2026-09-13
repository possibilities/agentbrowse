import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReply, waitReply } from "./coordination.ts";

test("wrong action, changed bytes and explicit rejection never authorize dispatch", () => {
  const expected = { intentId: "owned", intentSha256: "exact", allow: true };
  for (const changes of [{ intentId: "stale" }, { intentSha256: "changed" }, { allow: false }])
    expect(() =>
      checkReply(Buffer.from(JSON.stringify({ ...expected, ...changes })), expected),
    ).toThrow();
  expect(() => checkReply(Buffer.from(JSON.stringify(expected)), expected)).not.toThrow();
});
test("missing reply times out and cancellation prevents acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "coordination-"));
  try {
    await expect(
      waitReply(join(root, "missing"), {}, performance.now() + 20, async () => {}),
    ).rejects.toThrow("deadline expired");
    await expect(
      waitReply(join(root, "missing"), {}, performance.now() + 1000, async () => {
        throw new Error("owner abort");
      }),
    ).rejects.toThrow("owner abort");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
