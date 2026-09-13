import { expect, test } from "bun:test";
import { type ControlState, nativeCenter, unchangedControl } from "./layout.ts";
import { validate } from "./run.ts";

const before: ControlState = {
  value: "77",
  checked: false,
  selectedIndex: null,
  focused: false,
  disabled: false,
  rect: { x: 100, y: 1400, width: 200, height: 20 },
};
test("focus and scroll are selector-only actions; changed values/focus loss fail closed", () => {
  expect(() =>
    validate("http://127.0.0.1:4317/", 50, [
      { type: "focus", selector: "#size" },
      { type: "scrollintoview", selector: "#size" },
    ]),
  ).not.toThrow();
  expect(() => unchangedControl(before, { ...before, focused: true }, true)).not.toThrow();
  expect(() => unchangedControl(before, { ...before, value: "78", focused: true }, true)).toThrow();
  expect(() => unchangedControl(before, before, true)).toThrow();
});
test("native pointer uses freshly observed display-space center, rejecting offscreen and invalid geometry", () => {
  expect(() => nativeCenter(before)).toThrow();
  expect(nativeCenter({ ...before, rect: { x: 100, y: 500, width: 200, height: 20 } })).toEqual({
    x: 200,
    y: 510,
  });
  expect(() =>
    nativeCenter({ ...before, rect: { x: NaN, y: 500, width: 200, height: 20 } }),
  ).toThrow();
});
