import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { acceptPreparation, preparationWindow } from "./preparation.ts";

test("ready accepts only observed preparation identity and exact immutable script bytes", () => {
  const script = Buffer.from('[{"type":"wait","ms":0}]');
  const ready = {
    preparationId: "owned-prep",
    identitySha256: "owned-page",
    scriptSha256: createHash("sha256").update(script).digest("hex"),
  };
  const bytes = () => Buffer.from(JSON.stringify(ready));
  expect(acceptPreparation(bytes(), script, "owned-prep", "owned-page")).toEqual([
    { type: "wait", ms: 0 },
  ]);
  expect(() => acceptPreparation(bytes(), Buffer.from("[]"), "owned-prep", "owned-page")).toThrow();
  expect(() => acceptPreparation(bytes(), script, "old-prep", "owned-page")).toThrow();
  expect(() => acceptPreparation(bytes(), script, "owned-prep", "replacement-page")).toThrow();
});

test("authoring window is practical and finite, never an implied ready", () => {
  expect(preparationWindow(undefined)).toBe(0);
  expect(preparationWindow("600")).toBe(600);
  for (const value of ["0", "59", "901", "Infinity", "1.5"])
    expect(() => preparationWindow(value)).toThrow();
});
