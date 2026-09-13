import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureProvider } from "./provider.ts";

test("driver detach retains exact capture lease and rejects foreign cleanup", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-provider-"));
  const saved = {
    session: "capture",
    lease: "owned-token",
    profile: "owned-profile",
    target: { name: "owned-target", backend: "local" },
  };
  writeFileSync(join(root, "provider-lease.json"), JSON.stringify(saved));
  const request = {
    protocol: "agent-browser.plugin.v1",
    capability: "browser.provider",
    type: "browser.close",
    request: {
      session: saved.session,
      lease: saved.lease,
      browserTarget: saved.target.name,
      backend: "local",
      browserProfile: saved.profile,
    },
  };
  try {
    const response = JSON.parse(await captureProvider(JSON.stringify(request), root, "capture"));
    expect(response.success).toBe(true);
    expect(response.data.released).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "provider-lease.json"), "utf8"))).toEqual(saved);
    expect(JSON.parse(readFileSync(join(root, "driver-detached.json"), "utf8")).lease).toBe(
      saved.lease,
    );
    request.request.lease = "replacement-token";
    expect(
      JSON.parse(await captureProvider(JSON.stringify(request), root, "capture")).success,
    ).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uncertain initial launch cannot be replayed into a replacement target", async () => {
  const root = mkdtempSync(join(tmpdir(), "capture-provider-"));
  writeFileSync(join(root, "provider-launch-intent"), "uncertain");
  try {
    const response = JSON.parse(
      await captureProvider(
        JSON.stringify({
          protocol: "agent-browser.plugin.v1",
          capability: "browser.provider",
          type: "browser.launch",
          request: { session: "capture" },
        }),
        root,
        "capture",
      ),
    );
    expect(response.success).toBe(false);
    expect(readFileSync(join(root, "provider-launch-intent"), "utf8")).toBe("uncertain");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
