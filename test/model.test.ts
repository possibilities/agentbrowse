import { expect, test } from "bun:test";

import { CliError, UsageError } from "../cli/errors.ts";
import {
  CHROMIUM_FLAGS,
  parseTargetConfig,
  providerTargetName,
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

test("provider target names preserve compatible sessions and safely map the rest", () => {
  expect(providerTargetName("demo")).toBe("demo");
  expect(providerTargetName("Demo_Worktree")).toMatch(/^demo-worktree-[a-f0-9]{8}$/);
  expect(providerTargetName("123")).toMatch(/^s-123-[a-f0-9]{8}$/);
  expect(providerTargetName("Demo_Worktree")).not.toBe(providerTargetName("demo-worktree"));
  expect(providerTargetName("x".repeat(100))).toHaveLength(32);
});

test("runtime metadata round trips and rejects drift", () => {
  const target = targetFor("testing", 7, "artbird", "agentbrowse-browser-testing-generation");
  expect(parseTargetConfig(renderTargetConfig(target))).toEqual(target);
  expect(() =>
    parseTargetConfig(renderTargetConfig(target).replace('"slot": 7', '"slot": 1000')),
  ).toThrow(CliError);
});
