import { expect, test } from "bun:test";

import { CliError, UsageError } from "../cli/errors.ts";
import {
  CHROMIUM_FLAGS,
  incarnatedTargetName,
  parseTargetConfig,
  profileFor,
  providerProfileName,
  renderTargetConfig,
  targetFor,
  validateName,
  validateSlot,
} from "../cli/model.ts";

test("Chromium fills the remote desktop without kiosk mode", () => {
  expect(CHROMIUM_FLAGS).toBe("--start-fullscreen --disable-infobars");
});

test("slot deterministically assigns all browser ports", () => {
  expect(targetFor("testing", 7)).toEqual({
    name: "testing",
    profile: "testing",
    slot: 7,
    backend: "docker",
    container: "agentbrowse-browser-testing",
    httpPort: 18087,
    webrtcPort: 56007,
    cdpPort: 9229,
  });
});

test("names and slots reject unsafe values", () => {
  expect(() => validateName("../foreign")).toThrow(UsageError);
  expect(() => validateName("Uppercase")).toThrow(UsageError);
  expect(() => validateSlot(-1)).toThrow(UsageError);
  expect(() => validateSlot(1000)).toThrow(UsageError);
});

test("provider profile names preserve compatible sessions and safely map the rest", () => {
  expect(providerProfileName("demo")).toBe("demo");
  expect(providerProfileName("Demo_Worktree")).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
  expect(providerProfileName("123")).toMatch(/^s-123-[a-f0-9]{8}$/);
  expect(providerProfileName("Demo_Worktree")).not.toBe(providerProfileName("demo-worktree"));
  expect(providerProfileName("x".repeat(100))).toHaveLength(32);
});

test("Browser profiles and target incarnations have separate identities", () => {
  expect(profileFor("research")).toEqual({
    name: "research",
    volume: "agentbrowse-profile-research",
  });
  expect(incarnatedTargetName("research", "deadbeefcafebabe")).toBe("research-deadbeefcafebabe");
  expect(incarnatedTargetName("x".repeat(32), "deadbeefcafebabe")).toHaveLength(32);
  expect(() => incarnatedTargetName("research", "not-a-token")).toThrow(UsageError);
});

test("runtime metadata round trips and rejects drift", () => {
  const target = targetFor("testing-deadbeef", 7, {
    profile: "testing",
    backend: "remote-docker",
    container: "agentbrowse-browser-testing-generation",
  });
  expect(parseTargetConfig(renderTargetConfig(target))).toEqual(target);
  expect(() =>
    parseTargetConfig(renderTargetConfig(target).replace('"slot": 7', '"slot": 1000')),
  ).toThrow(CliError);
});

test("backend-bound runtime metadata requires an explicit Browser profile", () => {
  const target = targetFor("testing", 7);
  const incomplete = renderTargetConfig(target).replace('  "profile": "testing",\n', "");
  expect(() => parseTargetConfig(incomplete)).toThrow(CliError);
});
