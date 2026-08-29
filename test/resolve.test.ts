import { expect, test } from "bun:test";

import type { BrowserListEntry } from "../cli/farm.ts";
import { providerSessionProfileName, resolveProviderTarget } from "../cli/resolve.ts";

function target(
  profile: string,
  state = "running",
  name = `${profile.slice(0, 15)}-0123456789abcdef`,
): BrowserListEntry {
  return {
    name,
    profile,
    backend: "artbird",
    slot: 3,
    container: `agentbrowse-browser-${name}`,
    state,
    status: state,
    cdpUrl: "http://100.64.0.8:9225",
    liveViewUrl: "http://127.0.0.1:18083",
    liveViewAccess: { mode: "ssh", remoteHost: "artbird", remotePort: 18083 },
    slotConflict: false,
  };
}

test("provider sessions resolve through the same stable profile mapping as launch and view", async () => {
  let requestedProfile: string | undefined;
  let requestedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const resolved = await resolveProviderTarget(
    "Demo_Worktree",
    {
      targetForProfile: async (profile, signal) => {
        requestedProfile = profile;
        requestedSignal = signal;
        return target(profile, "running", "demo-worktree-0123456789abcdef");
      },
    },
    controller.signal,
  );

  expect(providerSessionProfileName("research")).toBe("research");
  expect(requestedProfile).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
  expect(requestedSignal).toBe(controller.signal);
  expect(resolved).toMatchObject({
    session: "Demo_Worktree",
    profile: requestedProfile,
    target: { name: "demo-worktree-0123456789abcdef", state: "running" },
  });
});

test("resolution refuses absent, stopped, and ambiguous exact targets", async () => {
  await expect(
    resolveProviderTarget("research", { targetForProfile: async () => undefined }),
  ).rejects.toMatchObject({ code: "browser_target_not_found" });

  await expect(
    resolveProviderTarget("research", {
      targetForProfile: async () => target("research", "exited"),
    }),
  ).rejects.toMatchObject({ code: "browser_target_not_running" });

  await expect(
    resolveProviderTarget("research", {
      targetForProfile: async () => ({ ...target("research"), slotConflict: true }),
    }),
  ).rejects.toMatchObject({ code: "browser_target_slot_conflict" });
});
