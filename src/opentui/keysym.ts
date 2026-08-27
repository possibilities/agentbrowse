import type { KeyEvent } from "@opentui/core";

export interface OpenTuiModifierSnapshot {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  hyper: boolean;
}

export const X11_MODIFIER_KEYSYMS = {
  shift: 0xffe1n,
  control: 0xffe3n,
  alt: 0xffe9n,
  meta: 0xffe7n,
  hyper: 0xffedn,
} as const;

const MODIFIER_NAMES: Readonly<Record<string, keyof OpenTuiModifierSnapshot>> = {
  leftshift: "shift",
  rightshift: "shift",
  leftctrl: "control",
  rightctrl: "control",
  leftalt: "alt",
  rightalt: "alt",
  leftsuper: "meta",
  rightsuper: "meta",
  leftmeta: "meta",
  rightmeta: "meta",
  lefthyper: "hyper",
  righthyper: "hyper",
};

const SPECIAL_KEYSYMS: Readonly<Record<string, bigint>> = {
  backspace: 0xff08n,
  tab: 0xff09n,
  linefeed: 0xff0an,
  clear: 0xff0bn,
  enter: 0xff0dn,
  return: 0xff0dn,
  pause: 0xff13n,
  scrolllock: 0xff14n,
  escape: 0xff1bn,
  home: 0xff50n,
  left: 0xff51n,
  up: 0xff52n,
  right: 0xff53n,
  down: 0xff54n,
  pageup: 0xff55n,
  pagedown: 0xff56n,
  end: 0xff57n,
  printscreen: 0xff61n,
  insert: 0xff63n,
  menu: 0xff67n,
  numlock: 0xff7fn,
  kpenter: 0xff8dn,
  kphome: 0xff95n,
  kpleft: 0xff96n,
  kpup: 0xff97n,
  kpright: 0xff98n,
  kpdown: 0xff99n,
  kppageup: 0xff9an,
  kppagedown: 0xff9bn,
  kpend: 0xff9cn,
  kpinsert: 0xff9en,
  kpdelete: 0xff9fn,
  kpequal: 0xffbdn,
  kpmultiply: 0xffaan,
  kpplus: 0xffabn,
  kpseparator: 0xffacn,
  kpminus: 0xffadn,
  kpdecimal: 0xffaen,
  kpdivide: 0xffafn,
  kp0: 0xffb0n,
  kp1: 0xffb1n,
  kp2: 0xffb2n,
  kp3: 0xffb3n,
  kp4: 0xffb4n,
  kp5: 0xffb5n,
  kp6: 0xffb6n,
  kp7: 0xffb7n,
  kp8: 0xffb8n,
  kp9: 0xffb9n,
  delete: 0xffffn,
  capslock: 0xffe5n,
  iso_level3_shift: 0xfe03n,
  iso_level5_shift: 0xfe11n,
  mediaplay: 0x1008ff14n,
  mediapause: 0x1008ff31n,
  mediaplaypause: 0x1008ff14n,
  mediastop: 0x1008ff15n,
  mediafastforward: 0x1008ff97n,
  mediarewind: 0x1008ff3en,
  medianext: 0x1008ff17n,
  mediaprev: 0x1008ff16n,
  volumedown: 0x1008ff11n,
  volumeup: 0x1008ff13n,
  mute: 0x1008ff12n,
};

const UNSHIFTED_ASCII: Readonly<Record<string, string>> = {
  "~": "`",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

export function isOpenTuiModifierKey(key: Pick<KeyEvent, "name">): boolean {
  return key.name.toLowerCase() in MODIFIER_NAMES;
}

/**
 * OpenTUI exposes the modifier state on every parsed key. Modifier-only Kitty
 * events are folded into that state so the native session remains the single
 * authority for which X11 keysyms are actually held. OpenTUI's compatibility
 * model calls terminal Alt/Option `meta` and the platform Command/Windows key
 * `super`; map those semantic roles to X11 Alt and Meta so OpenTUI and AppKit
 * produce the same browser shortcuts.
 */
export function openTuiModifierSnapshot(
  key: Pick<
    KeyEvent,
    "name" | "eventType" | "shift" | "ctrl" | "meta" | "option" | "super" | "hyper"
  >,
): OpenTuiModifierSnapshot {
  const name = key.name.toLowerCase();
  const namedModifier = MODIFIER_NAMES[name];
  const pressed = key.eventType !== "release";
  const snapshot: OpenTuiModifierSnapshot = {
    shift: key.shift,
    control: key.ctrl,
    alt: key.option || (key.meta && !key.super),
    meta: Boolean(key.super),
    hyper: Boolean(key.hyper),
  };
  if (namedModifier) snapshot[namedModifier] = pressed;
  return snapshot;
}

/** Map an OpenTUI key to the X11 keysym expected by Neko's input channel. */
export function keysymForOpenTuiKey(key: Pick<KeyEvent, "name" | "shift">): bigint | null {
  const name = key.name.toLowerCase();
  if (name === "space") return 0x20n;
  const special = SPECIAL_KEYSYMS[name];
  if (special !== undefined) return special;

  const functionMatch = /^f([1-9]|[12][0-9]|3[0-5])$/u.exec(name);
  if (functionMatch) return 0xffben + BigInt(Number(functionMatch[1]) - 1);

  const characters = [...key.name];
  if (characters.length !== 1) return null;
  let character = characters[0]!;
  if (/^[A-Z]$/u.test(character)) character = character.toLowerCase();
  else if (key.shift) character = UNSHIFTED_ASCII[character] ?? character;
  const codepoint = character.codePointAt(0);
  if (codepoint === undefined || codepoint < 0x20 || codepoint === 0x7f) return null;
  if (codepoint <= 0xff) return BigInt(codepoint);
  return 0x0100_0000n | BigInt(codepoint);
}
