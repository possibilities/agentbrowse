import { expect, test } from "bun:test";

import { UsageError } from "../cli/errors.ts";
import { parseArgs } from "../cli/main.ts";

test("profile archive commands and explicit forced cleanup keep their complete arguments", () => {
  expect(
    parseArgs(["profile", "export", "research", "/tmp/private archive.tar.zst", "--json"]),
  ).toEqual({
    command: "profile",
    action: "export",
    name: "research",
    path: "/tmp/private archive.tar.zst",
    json: true,
  });
  expect(
    parseArgs(["profile", "import", "copy", "/tmp/profile.tar.zst", "--backend", "local"]),
  ).toEqual({
    command: "profile",
    action: "import",
    name: "copy",
    path: "/tmp/profile.tar.zst",
    backend: "local",
    json: false,
  });
  expect(parseArgs(["destroy", "stuck", "--force"])).toEqual({
    command: "destroy",
    name: "stuck",
    force: true,
    json: false,
  });
  expect(() => parseArgs(["profile", "import", "copy"])).toThrow(UsageError);
  expect(() =>
    parseArgs(["profile", "export", "research", "/tmp/a", "--backend", "local"]),
  ).toThrow(UsageError);
});

test("parse target, profile, provider, resolve, and view commands", () => {
  expect(
    parseArgs([
      "create",
      "testing-target",
      "--slot",
      "4",
      "--profile",
      "testing-profile",
      "--json",
    ]),
  ).toEqual({
    command: "create",
    name: "testing-target",
    profile: "testing-profile",
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
  expect(parseArgs(["profile", "create", "testing", "--json"])).toEqual({
    command: "profile",
    action: "create",
    name: "testing",
    json: true,
  });
  expect(parseArgs(["profile", "list"])).toEqual({
    command: "profile",
    action: "list",
    json: false,
  });
  expect(parseArgs(["profile", "delete", "testing"])).toEqual({
    command: "profile",
    action: "delete",
    name: "testing",
    json: false,
  });
  expect(parseArgs(["provider"])).toEqual({
    command: "provider",
    json: false,
  });
  expect(parseArgs(["resolve", "Demo_Worktree", "--json"])).toEqual({
    command: "resolve",
    session: "Demo_Worktree",
    json: true,
  });
  expect(parseArgs(["resolve"])).toEqual({
    command: "resolve",
    session: "default",
    json: false,
  });
  expect(parseArgs(["view", "Demo_Worktree"])).toEqual({
    command: "view",
    session: "Demo_Worktree",
    json: false,
  });
  expect(parseArgs(["view"])).toEqual({
    command: "view",
    session: "default",
    json: false,
  });
});

test("create requires an explicit slot", () => {
  expect(() => parseArgs(["create", "testing"])).toThrow(UsageError);
});

test("unknown command and extra destroy flags are usage faults", () => {
  expect(() => parseArgs(["unknown"])).toThrow(UsageError);
  expect(() => parseArgs(["destroy", "testing", "--slot", "3"])).toThrow(UsageError);
  expect(() => parseArgs(["list", "extra"])).toThrow(UsageError);
  expect(() => parseArgs(["provider", "extra"])).toThrow(UsageError);
  expect(() => parseArgs(["provider", "--json"])).toThrow(UsageError);
  expect(() => parseArgs(["resolve", "testing", "extra"])).toThrow(UsageError);
  expect(() => parseArgs(["resolve", "--unknown"])).toThrow(UsageError);
  expect(() => parseArgs(["view", "testing", "extra"])).toThrow(UsageError);
  expect(() => parseArgs(["view", "--unknown"])).toThrow(UsageError);
  expect(() => parseArgs(["view", "testing", "--json"])).toThrow(UsageError);
  expect(() => parseArgs(["profile"])).toThrow(UsageError);
  expect(() => parseArgs(["profile", "unknown"])).toThrow(UsageError);
  expect(() => parseArgs(["profile", "create"])).toThrow(UsageError);
  expect(() => parseArgs(["profile", "list", "extra"])).toThrow(UsageError);
});
