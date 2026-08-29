import { expect, test } from "bun:test";

import type { BrowserListEntry } from "../cli/farm.ts";
import { runView, viewProfileName } from "../cli/view.ts";

function target(
  profile: string,
  state = "running",
  name = `${profile.slice(0, 23)}-deadbeef`,
): BrowserListEntry {
  return {
    name,
    profile,
    backend: "artbird",
    slot: 1,
    container: `agentbrowse-browser-${name}`,
    state,
    status: state,
    cdpUrl: "http://100.64.0.8:9223",
    liveViewUrl: "http://127.0.0.1:18081",
    liveViewAccess: { mode: "ssh", remoteHost: "artbird", remotePort: 18081 },
    slotConflict: false,
  };
}

test("view uses the provider's stable session-to-profile mapping", () => {
  expect(viewProfileName("research")).toBe("research");
  expect(viewProfileName("Demo_Worktree")).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
});

test("view resolves the profile's current target and launches that exact incarnation", async () => {
  const env = { AGENTBROWSE_REMOTE_HOST: "browser-host" };
  let launchedTarget: string | undefined;
  let launchedEnv: Readonly<Record<string, string | undefined>> | undefined;
  let requestedProfile: string | undefined;

  const exitCode = await runView(
    "Demo_Worktree",
    env,
    async (name, suppliedEnv) => {
      launchedTarget = name;
      launchedEnv = suppliedEnv;
      return 0;
    },
    {
      targetForProfile: async (profile) => {
        requestedProfile = profile;
        return target(profile, "running", "live-incarnation");
      },
    },
  );

  expect(exitCode).toBe(0);
  expect(requestedProfile).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
  expect(launchedTarget).toBe("live-incarnation");
  expect(launchedEnv).toBe(env);
});

test("view propagates a launcher failure exit code", async () => {
  expect(
    await runView("research", {}, async () => 17, {
      targetForProfile: async () => target("research"),
    }),
  ).toBe(17);
});

test("view refuses absent and stopped profile targets", async () => {
  await expect(
    runView("research", {}, async () => 0, {
      targetForProfile: async () => undefined,
    }),
  ).rejects.toMatchObject({ code: "browser_target_not_found" });

  await expect(
    runView("research", {}, async () => 0, {
      targetForProfile: async () => target("research", "exited"),
    }),
  ).rejects.toMatchObject({ code: "browser_target_not_running" });
});

test("view refuses a target whose slot identity is ambiguous", async () => {
  await expect(
    runView("research", {}, async () => 0, {
      targetForProfile: async () => ({ ...target("research"), slotConflict: true }),
    }),
  ).rejects.toMatchObject({ code: "browser_target_slot_conflict" });
});
