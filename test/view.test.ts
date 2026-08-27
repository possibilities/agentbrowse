import { expect, test } from "bun:test";

import { runView, viewTargetName } from "../cli/view.ts";

test("view uses the provider's stable session-to-target mapping", () => {
  expect(viewTargetName("research")).toBe("research");
  expect(viewTargetName("Demo_Worktree")).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
});

test("view launches the mapped target with the supplied environment", async () => {
  const env = { AGENTBROWSE_REMOTE_HOST: "browser-host" };
  let launchedTarget: string | undefined;
  let launchedEnv: Readonly<Record<string, string | undefined>> | undefined;

  const exitCode = await runView("Demo_Worktree", env, async (target, suppliedEnv) => {
    launchedTarget = target;
    launchedEnv = suppliedEnv;
    return 0;
  });

  expect(exitCode).toBe(0);
  expect(launchedTarget).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
  expect(launchedEnv).toBe(env);
});

test("view propagates a launcher failure exit code", async () => {
  expect(await runView("research", {}, async () => 17)).toBe(17);
});
