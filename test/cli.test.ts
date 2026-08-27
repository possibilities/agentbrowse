import { expect, test } from "bun:test";

import { UsageError } from "../cli/errors.ts";
import { parseArgs } from "../cli/main.ts";

test("parse create, list, and destroy commands", () => {
  expect(parseArgs(["create", "testing", "--slot", "4", "--json"])).toEqual({
    command: "create",
    name: "testing",
    slot: 4,
    json: true,
  });
  expect(parseArgs(["destroy", "testing"])).toEqual({
    command: "destroy",
    name: "testing",
    json: false,
  });
  expect(parseArgs(["list", "--json"])).toEqual({
    command: "list",
    json: true,
  });
});

test("create requires an explicit slot", () => {
  expect(() => parseArgs(["create", "testing"])).toThrow(UsageError);
});

test("unknown command and extra destroy flags are usage faults", () => {
  expect(() => parseArgs(["unknown"])).toThrow(UsageError);
  expect(() => parseArgs(["destroy", "testing", "--slot", "3"])).toThrow(UsageError);
  expect(() => parseArgs(["list", "extra"])).toThrow(UsageError);
});
