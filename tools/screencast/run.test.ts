import { expect, test } from "bun:test";
import { targetFor } from "../../cli/model.ts";
import type { SessionReceipt } from "../../cli/sessions.ts";
import { assertOwner } from "./identity.ts";
import { validate } from "./run.ts";

test("only an explicit fixed loopback origin and bounded action program are accepted", () => {
  const actions = [{ type: "click", selector: "#route" }];
  expect(() => validate("http://127.0.0.1:4317/", 20, actions)).not.toThrow();
  for (const url of [
    "http://localhost:4317/",
    "http://192.168.1.2:4317/",
    "https://127.0.0.1:4317/",
    "http://127.0.0.1:4317/?destination=22",
  ])
    expect(() => validate(url, 20, actions)).toThrow();
  expect(() => validate("http://127.0.0.1:4317/", 121, actions)).toThrow();
  expect(() =>
    validate("http://127.0.0.1:4317/", 20, [{ type: "eval", expression: "fetch('/save')" }]),
  ).toThrow();
});

test("lease and exact VM identity fence stale and cross-session grants", () => {
  const target = targetFor("fixture", 0, {
    profile: "fixture",
    backend: "local",
    container: "owned-container",
  });
  const lease: SessionReceipt = {
    version: 1,
    session: "fixture",
    profile: "fixture",
    persistent: false,
    lease: "a".repeat(32),
    createdAt: "2026-09-12",
    target: { name: "fixture", backend: "local" },
  };
  const row = {
    id: "immutable-id",
    name: "owned-container",
    state: "Running",
    tags: {
      "dev.agentbrowse.managed": "true",
      "dev.agentbrowse.role": "kernel-browser",
      "dev.agentbrowse.target": "fixture",
      "dev.agentbrowse.profile": "fixture",
      "dev.agentbrowse.backend": "local",
    },
  };
  expect(assertOwner(lease, lease, target, row)).toBe("immutable-id");
  expect(() => assertOwner(lease, { ...lease, lease: "b".repeat(32) }, target, row)).toThrow();
  expect(() =>
    assertOwner(lease, lease, target, { ...row, id: "replacement" }, "immutable-id"),
  ).toThrow();
  expect(() =>
    assertOwner(lease, lease, target, {
      ...row,
      tags: { ...row.tags, "dev.agentbrowse.profile": "other" },
    }),
  ).toThrow();
  expect(() => assertOwner(lease, undefined, target, row)).toThrow();
});

test("failure between owner precheck and dispatch fences both channels irreversibly", async () => {
  const { SafetyLatch } = await import("./safety.ts");
  const dispatched: string[] = [];
  let stopped = 0;
  const latch = new SafetyLatch(() => stopped++);
  const dispatch = (channel: string) => {
    latch.check();
    dispatched.push(channel);
  };
  latch.check();
  await Promise.resolve().then(() => latch.trip(new Error("transport lost")));
  for (const channel of ["driver click", "driver press", "native pointer"])
    expect(() => dispatch(channel)).toThrow("transport lost");
  latch.trip(new Error("later lease replacement"));
  expect(stopped).toBe(1);
  expect(dispatched).toEqual([]);
});
