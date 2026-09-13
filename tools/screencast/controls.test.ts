import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { OBSERVE_CONTROLS } from "./controls.ts";

function observe(type: string, count: number, options = 0) {
  const node = Object.freeze({
    tagName: type === "select" ? "SELECT" : "INPUT",
    type,
    id: "fixture",
    name: "fixture",
    value: "private-text",
    valueAsNumber: NaN,
    labels: [],
    options: Array.from({ length: options }, (_, i) => ({
      value: String(i),
      label: String(i),
      selected: false,
      disabled: false,
    })),
    getAttribute: () => null,
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      width: 20,
      height: 10,
      left: 0,
      top: 0,
      right: 20,
      bottom: 10,
    }),
  });
  return runInNewContext(OBSERVE_CONTROLS, {
    document: {
      querySelectorAll: (selector: string) =>
        selector.startsWith("#") ? [node] : Array(count).fill(node),
    },
    CSS: { escape: (s: string) => s },
    innerWidth: 1920,
    innerHeight: 1080,
    scrollX: 0,
    scrollY: 0,
    getComputedStyle: () => ({ visibility: "visible", display: "block", opacity: "1" }),
  });
}
test("read-only evidence does not expose text or password values", () => {
  for (const type of ["text", "password", "file", "hidden"])
    expect(observe(type, 1).controls[0].value).toBeNull();
});
test("large control and option collections are explicitly truncated", () => {
  const result = observe("select", 300, 100);
  expect(result.total).toBe(300);
  expect(result.truncated).toBe(true);
  expect(result.controls.length).toBe(256);
  expect(result.controls[0].options.length).toBe(64);
  expect(result.controls[0].optionsTruncated).toBe(true);
});
