import { expect, test } from "bun:test";

import { CliError, UsageError } from "../cli/errors.ts";
import {
  CHROMIUM_FLAGS,
  parseTargetConfig,
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

test("runtime metadata round trips and rejects drift", () => {
  const target = targetFor("testing", 7);
  expect(parseTargetConfig(renderTargetConfig(target))).toEqual(target);
  expect(() =>
    parseTargetConfig(renderTargetConfig(target).replace("CDP_PORT=9229", "CDP_PORT=9999")),
  ).toThrow(CliError);
});
