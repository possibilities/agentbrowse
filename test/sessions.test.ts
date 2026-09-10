import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFleet } from "../cli/fleet.ts";
import { targetFor } from "../cli/model.ts";
import { ProfileBindingStore } from "../cli/profile-binding.ts";
import { MAX_DISPOSABLE_SESSIONS, ProviderSessions } from "../cli/sessions.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "ab-sessions-"));
  dirs.push(dir);
  const profiles = new Set<string>();
  const bindings = new ProfileBindingStore(dir);
  let serial = 0;
  let shutdownError = false;
  let launchError = false;
  const destroyed: string[] = [];
  const targets = new Map<string, ReturnType<typeof targetFor>>();
  const farm = {
    bindings,
    async listProfiles() {
      return [...profiles].map((name) => ({ name, backend: "local" }));
    },
    async list() {
      return [...targets.values()];
    },
    async provisionProfile({ profile }: { profile: string }) {
      await bindings.bindProfile(profile, "local");
      profiles.add(profile);
      const target = targetFor(`target-${++serial}`, 0, { profile, backend: "local" });
      targets.set(profile, target);
      if (launchError) throw new Error("launch failed after VM creation");
      await bindings.bindTarget(target);
      return {
        ...target,
        image: "fixture",
        cdpUrl: "http://unused",
        liveViewUrl: "http://unused",
        liveViewAccess: { mode: "direct", baseUrl: "http://unused" },
        created: true,
      };
    },
    async destroy(name: string, backend: string, profile: string) {
      if (shutdownError) throw new Error("shutdown failed");
      destroyed.push(name);
      targets.delete(profile);
      await bindings.clearTarget({ name, backend, profile });
    },
    async deleteProfile(profile: string) {
      profiles.delete(profile);
      await bindings.delete(profile, "local");
    },
  } as unknown as BrowserFleet;
  const sessions = new ProviderSessions(farm, dir);
  return {
    sessions,
    farm,
    profiles,
    destroyed,
    targets,
    setShutdownError: (v: boolean) => {
      shutdownError = v;
    },
    setLaunchError: (v: boolean) => {
      launchError = v;
    },
  };
}

test("ordinary close releases the VM, temporary volume and receipt; reopening starts fresh", async () => {
  const { sessions, profiles, destroyed } = setup();
  const first = await sessions.launch("research");
  expect(first.receipt.persistent).toBe(false);
  expect(await sessions.profileForSession("research")).toBe(first.receipt.profile);
  expect(profiles.size).toBe(1);
  await sessions.release("research", first.receipt.lease);
  expect(profiles.size).toBe(0);
  expect(destroyed).toEqual([first.result.name]);
  expect(await sessions.list()).toEqual([]);
  const second = await sessions.launch("research");
  expect(second.receipt.profile).not.toBe(first.receipt.profile);
  expect(await sessions.release("research", first.receipt.lease)).toEqual({ released: false });
  expect(await sessions.read("research")).toEqual(second.receipt);
});

test("personal profile has one exclusive task owner; successive tasks retain the same profile", async () => {
  const { sessions, profiles } = setup();
  const first = await sessions.prepare("job-a", "personal");
  expect(await sessions.prepare("job-a", "personal")).toEqual(first);
  await expect(sessions.prepare("job-b", "personal")).rejects.toMatchObject({
    code: "profile_leased",
  });
  await sessions.launch("job-a");
  await sessions.release("job-a", first.lease);
  expect(profiles.has("personal")).toBe(true);
  const second = await sessions.prepare("job-b", "personal");
  expect(second.profile).toBe("personal");
  expect(second.lease).not.toBe(first.lease);
});

test("two concurrent owners cannot acquire a personal profile", async () => {
  const { sessions } = setup();
  const results = await Promise.allSettled([
    sessions.prepare("a", "personal"),
    sessions.prepare("b", "personal"),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(await sessions.list()).toHaveLength(1);
});

test("failed launch retains cleanup ownership even before the target binding is written", async () => {
  const s = setup();
  s.setLaunchError(true);
  await expect(s.sessions.launch("failed")).rejects.toThrow("launch failed");
  const [receipt] = await s.sessions.list();
  expect(receipt?.target).toBeNull();
  await s.sessions.release("failed", receipt!.lease);
  expect(s.profiles.size).toBe(0);
  expect(s.targets.size).toBe(0);
});

test("failed shutdown retains the profile, lease, and target for recovery", async () => {
  const s = setup();
  const { receipt } = await s.sessions.launch("held");
  s.setShutdownError(true);
  await expect(s.sessions.release("held", receipt.lease)).rejects.toThrow("shutdown failed");
  expect(s.profiles.size).toBe(1);
  expect(await s.sessions.read("held")).toEqual(receipt);
  s.setShutdownError(false);
  await s.sessions.release("held", receipt.lease);
  expect(s.profiles.size).toBe(0);
});

test("unfinished disposable jobs are bounded, including failed and merely prepared launches", async () => {
  const { sessions } = setup();
  for (let i = 0; i < MAX_DISPOSABLE_SESSIONS; i++) await sessions.prepare(`job-${i}`);
  await expect(sessions.prepare("overflow")).rejects.toMatchObject({
    code: "disposable_capacity_exhausted",
  });
  expect(await sessions.list()).toHaveLength(MAX_DISPOSABLE_SESSIONS);
});

test("legacy saved profiles remain persistent and keep their running target", async () => {
  const { sessions, farm, profiles } = setup();
  profiles.add("legacy");
  await farm.provisionProfile({ profile: "legacy" });
  const receipt = await sessions.prepare("legacy");
  expect(receipt.persistent).toBe(true);
  expect(receipt.profile).toBe("legacy");
  await sessions.release("legacy", receipt.lease);
  expect(profiles.has("legacy")).toBe(true);
});

test("provider cleanup cannot substitute another target under the same lease", async () => {
  const { sessions, profiles } = setup();
  const { receipt } = await sessions.launch("owner");
  await expect(
    sessions.release("owner", receipt.lease, {
      browserTarget: "wrong",
      browserProfile: receipt.profile,
      backend: "local",
    }),
  ).rejects.toMatchObject({ code: "session_target_changed" });
  expect(profiles.has(receipt.profile)).toBe(true);
});
