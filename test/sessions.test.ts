import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFleet } from "../cli/fleet.ts";
import { providerProfileName, targetFor } from "../cli/model.ts";
import { ProfileBindingStore } from "../cli/profile-binding.ts";
import {
  MAX_DISPOSABLE_SESSIONS,
  ProviderSessions,
  withProviderSessionProfileExclusion,
} from "../cli/sessions.ts";

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
  const deleted: string[] = [];
  const destroyedIds: (string | undefined)[] = [];
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
    async destroy(
      name: string,
      backend: string,
      profile: string,
      _force: boolean,
      instanceId?: string,
    ) {
      destroyedIds.push(instanceId);
      if (shutdownError) throw new Error("shutdown failed");
      destroyed.push(name);
      targets.delete(profile);
      await bindings.clearTarget({ name, backend, profile });
    },
    async deleteProfile(profile: string) {
      deleted.push(profile);
      profiles.delete(profile);
      await bindings.delete(profile, "local");
    },
  } as unknown as BrowserFleet;
  const sessions = new ProviderSessions(farm, dir);
  return {
    sessions,
    dir,
    farm,
    bindings,
    profiles,
    destroyed,
    deleted,
    destroyedIds,
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
  expect(second.receipt.profile).toBe(first.receipt.profile);
  expect(second.receipt.lease).not.toBe(first.receipt.lease);
  expect(await sessions.release("research", first.receipt.lease)).toEqual({ released: false });
  expect(await sessions.read("research")).toEqual(second.receipt);
});

test("restore and prepare serialize so a prepared disposable name blocks restore", async () => {
  const s = setup();
  const profile = providerProfileName("race");
  const originalList = s.farm.listProfiles.bind(s.farm);
  let entered!: () => void;
  let unblock!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  s.farm.listProfiles = async () => {
    entered();
    await gate;
    return await originalList();
  };

  const preparing = s.sessions.prepare("race");
  await active;
  let restoreMutations = 0;
  const restoring = withProviderSessionProfileExclusion(s.dir, [profile], async () => {
    restoreMutations += 1;
    await s.bindings.reserveRestore([profile], "local", "1".repeat(64));
  });
  unblock();
  const receipt = await preparing;
  await expect(restoring).rejects.toMatchObject({ code: "profile_leased" });
  expect(receipt.profile).toBe(profile);
  expect(restoreMutations).toBe(0);
  expect(await s.bindings.read(profile)).toBeUndefined();
});

test("restore reservation wins before a concurrent session prepare or launch", async () => {
  const s = setup();
  const profile = providerProfileName("restore-first");
  let entered!: () => void;
  let unblock!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const restoring = withProviderSessionProfileExclusion(s.dir, [profile], async () => {
    await s.bindings.reserveRestore([profile], "local", "2".repeat(64));
    entered();
    await gate;
  });
  await active;
  const preparing = s.sessions.prepare("restore-first");
  unblock();
  await restoring;
  await expect(preparing).rejects.toMatchObject({ code: "profile_restore_pending" });
  await expect(s.sessions.launch("restore-first")).rejects.toMatchObject({
    code: "profile_restore_pending",
  });
  expect(await s.sessions.list()).toEqual([]);
});

test("an active launch holds the session registry through profile provisioning", async () => {
  const s = setup();
  const profile = providerProfileName("launch-race");
  const originalProvision = s.farm.provisionProfile.bind(s.farm);
  let entered!: () => void;
  let unblock!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  s.farm.provisionProfile = async (options) => {
    entered();
    await gate;
    return await originalProvision(options);
  };
  const launching = s.sessions.launch("launch-race");
  await active;
  let restoreMutations = 0;
  const restoring = withProviderSessionProfileExclusion(s.dir, [profile], async () => {
    restoreMutations += 1;
    await s.bindings.reserveRestore([profile], "local", "3".repeat(64));
  });
  unblock();
  await launching;
  await expect(restoring).rejects.toMatchObject({ code: "profile_leased" });
  expect(restoreMutations).toBe(0);
});

test("release finishes disposable deletion before restore can reserve the same name", async () => {
  const s = setup();
  const launched = await s.sessions.launch("release-race");
  const profile = launched.receipt.profile;
  const originalDestroy = s.farm.destroy.bind(s.farm);
  let entered!: () => void;
  let unblock!: () => void;
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  s.farm.destroy = async (...args) => {
    entered();
    await gate;
    return await originalDestroy(...args);
  };
  const releasing = s.sessions.release("release-race", launched.receipt.lease);
  await active;
  const restoring = withProviderSessionProfileExclusion(s.dir, [profile], async () => {
    await s.bindings.reserveRestore([profile], "local", "4".repeat(64));
  });
  unblock();
  await releasing;
  await restoring;
  expect(s.deleted).toEqual([profile]);
  expect(await s.bindings.read(profile)).toMatchObject({ pendingRestore: "4".repeat(64) });
});

test("stale disposable cleanup preserves a binding finalized by an older restore race", async () => {
  const s = setup();
  const receipt = await s.sessions.prepare("legacy-race");
  const digest = "5".repeat(64);
  // Reproduce the state an older client could create without the session registry lock.
  await s.bindings.reserveRestore([receipt.profile], "local", digest);
  await s.bindings.completeRestore([receipt.profile], "local", digest);
  const restoredTarget = targetFor("restored-target", 0, {
    profile: receipt.profile,
    backend: "local",
  });
  await s.bindings.bindTarget(restoredTarget);

  await expect(s.sessions.launch("legacy-race")).rejects.toMatchObject({
    code: "session_profile_changed",
  });
  expect(await s.sessions.release("legacy-race", receipt.lease)).toEqual({
    released: true,
    profile: receipt.profile,
    preserved: true,
  });
  expect(s.deleted).toEqual([]);
  expect(s.destroyed).toEqual([]);
  expect(await s.bindings.read(receipt.profile)).toMatchObject({
    restoredFrom: digest,
    target: restoredTarget,
  });
  expect(await s.sessions.list()).toEqual([]);
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

test("release carries original instance ID to destruction under the lease lock", async () => {
  const { sessions, destroyedIds } = setup();
  const { receipt } = await sessions.launch("uuid-owner");
  await sessions.release(receipt.session, receipt.lease, {
    browserTarget: receipt.target!.name,
    browserProfile: receipt.profile,
    backend: "local",
    instanceId: "original-uuid",
  });
  expect(destroyedIds).toEqual(["original-uuid"]);
});
