import type { KeyEvent } from "@opentui/core";

export interface OpenTuiModifierSnapshot {
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
  hyper: boolean;
}

export interface OpenTuiKeyTarget {
  keysym: bigint;
  forceControl: boolean;
  forceAlt: boolean;
  forceShift: boolean;
  removeShift: boolean;
  removeAlt: boolean;
  removeMeta: boolean;
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

const UNSHIFTED_LEVEL_ASCII = "`1234567890-=[]\\;',./";

/**
 * Command chords that become the guest's Control chords. W, N, P, and D are
 * deliberately absent: Control-W closes the guest tab, and on a single-tab
 * Kernel Chromium that exits the browser and the session; Control-N opens a
 * guest window, Control-P a modal print dialog, and Control-D a bookmark
 * bubble. An untranslated Command chord still reaches the guest as a harmless
 * Meta chord.
 */
const COMMAND_CONTROL_SHORTCUTS = new Set(["a", "c", "f", "l", "r", "t", "x", "z", "=", "-", "0"]);

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

/** A stable physical identity for matching Kitty press and release reports. */
export function openTuiPhysicalKeyIdentity(
  key: Pick<KeyEvent, "name" | "baseCode" | "code">,
): string {
  if (key.baseCode !== undefined) return `base:${key.baseCode}`;
  if (key.code) return `code:${key.code}`;
  return `name:${key.name.toLowerCase()}`;
}

/** Translate macOS browser conventions into the Linux guest's shortcuts. */
export function openTuiShortcutTranslation(
  key: Pick<KeyEvent, "name" | "baseCode" | "super" | "option" | "meta" | "shift"> &
    Partial<Pick<KeyEvent, "sequence" | "capsLock">>,
): OpenTuiKeyTarget | null {
  const command = Boolean(key.super);
  const option = Boolean(key.option || (key.meta && !key.super));
  const name = key.name.toLowerCase();

  if (command && !option) {
    const navigation =
      name === "left"
        ? 0xff50n
        : name === "right"
          ? 0xff57n
          : name === "up"
            ? 0xff50n
            : name === "down"
              ? 0xff57n
              : null;
    if (navigation !== null) {
      return {
        keysym: navigation,
        forceControl: name === "up" || name === "down",
        forceAlt: false,
        forceShift: key.shift,
        removeShift: false,
        removeAlt: false,
        removeMeta: true,
      };
    }
    const shortcutName = shortcutLayoutName(key);
    // Command-[ and Command-] are macOS Chrome's back and forward; Linux
    // Chrome navigates history with Alt-Left and Alt-Right.
    const history = shortcutName === "[" ? 0xff51n : shortcutName === "]" ? 0xff53n : null;
    if (history !== null) {
      return {
        keysym: history,
        forceControl: false,
        forceAlt: true,
        forceShift: key.shift,
        removeShift: false,
        removeAlt: false,
        removeMeta: true,
      };
    }
    if (!COMMAND_CONTROL_SHORTCUTS.has(shortcutName)) return null;
    const keysym = shortcutTargetKeysym(shortcutName, key.shift);
    return keysym === null
      ? null
      : {
          keysym,
          forceControl: true,
          forceAlt: false,
          forceShift: key.shift,
          removeShift: false,
          removeAlt: false,
          removeMeta: true,
        };
  }

  if (option && !command) {
    // macOS moves and deletes by word with Option; Linux Chrome uses Control.
    const editing =
      name === "left"
        ? 0xff51n
        : name === "right"
          ? 0xff53n
          : name === "backspace"
            ? 0xff08n
            : name === "delete"
              ? 0xffffn
              : null;
    if (editing !== null) {
      return {
        keysym: editing,
        forceControl: true,
        forceAlt: false,
        forceShift: key.shift,
        removeShift: false,
        removeAlt: true,
        removeMeta: false,
      };
    }
  }
  return null;
}

export function isOpenTuiLocalShortcut(
  key: Pick<KeyEvent, "name" | "baseCode" | "super">,
): boolean {
  if (!key.super) return false;
  const name = shortcutLayoutName(key);
  return name === "v" || name === "q";
}

export function applyOpenTuiKeyTargetModifiers(
  physical: OpenTuiModifierSnapshot,
  target: OpenTuiKeyTarget | null,
): OpenTuiModifierSnapshot {
  const effective = { ...physical };
  if (target?.forceControl) effective.control = true;
  if (target?.removeShift) effective.shift = false;
  if (target?.forceShift) effective.shift = true;
  if (target?.removeAlt) effective.alt = false;
  if (target?.forceAlt) effective.alt = true;
  if (target?.removeMeta) effective.meta = false;
  return effective;
}

function shortcutLayoutName(key: Pick<KeyEvent, "name" | "baseCode">): string {
  const layoutCharacter = singleAsciiCharacter(key.name);
  if (layoutCharacter !== null) return normalizeShortcutCharacter(layoutCharacter);
  if (key.baseCode !== undefined && key.baseCode >= 0 && key.baseCode <= 0x10ffff) {
    const baseCharacter = singleAsciiCharacter(String.fromCodePoint(key.baseCode));
    if (baseCharacter !== null) return normalizeShortcutCharacter(baseCharacter);
  }
  return key.name.toLowerCase();
}

function shortcutTargetKeysym(shortcutName: string, shifted: boolean): bigint | null {
  return keysymForCharacter(shifted ? shiftedAscii(shortcutName) : shortcutName);
}

function normalizeShortcutCharacter(character: string): string {
  const lower = character.toLowerCase();
  return UNSHIFTED_ASCII[lower] ?? lower;
}

function singleAsciiCharacter(value: string): string | null {
  const characters = [...value];
  if (characters.length !== 1) return null;
  const codepoint = characters[0]!.codePointAt(0)!;
  return codepoint >= 0x20 && codepoint <= 0x7e ? characters[0]! : null;
}

function shiftedAscii(character: string): string {
  const upper = character.toLocaleUpperCase();
  if (upper !== character && [...upper].length === 1) return upper;
  for (const [shifted, unshifted] of Object.entries(UNSHIFTED_ASCII)) {
    if (unshifted === character) return shifted;
  }
  return character;
}

/** Map an OpenTUI key to the X11 keysym expected by Neko's input channel. */
export function keysymForOpenTuiKey(
  key: Pick<KeyEvent, "name" | "shift"> & Partial<Pick<KeyEvent, "sequence">>,
): bigint | null {
  const name = key.name.toLowerCase();
  if (name === "space") return 0x20n;
  const special = SPECIAL_KEYSYMS[name];
  if (special !== undefined) return special;

  const functionMatch = /^f([1-9]|[12][0-9]|3[0-5])$/u.exec(name);
  if (functionMatch) return 0xffben + BigInt(Number(functionMatch[1]) - 1);

  const sequenceCharacter = reportedSequenceCharacter(key.sequence);
  let character = sequenceCharacter ?? singleCharacter(key.name);
  if (character === null) return null;
  if (key.shift && sequenceCharacter === null) character = shiftedAscii(character);
  return keysymForCharacter(character);
}

/** Whether an exact printable target needs the guest's shifted XKB level. */
export function openTuiKeyLevelRequiresShift(
  key: Pick<KeyEvent, "name" | "shift"> & Partial<Pick<KeyEvent, "sequence">>,
): boolean {
  return openTuiKeyShiftLevel(key) === "shifted";
}

/** Whether an exact printable target needs physical Shift suppressed. */
export function openTuiKeyLevelRemovesShift(
  key: Pick<KeyEvent, "name" | "shift"> & Partial<Pick<KeyEvent, "sequence">>,
): boolean {
  return openTuiKeyShiftLevel(key) === "unshifted";
}

function openTuiKeyShiftLevel(
  key: Pick<KeyEvent, "name" | "shift"> & Partial<Pick<KeyEvent, "sequence">>,
): "preserve" | "unshifted" | "shifted" {
  const sequenceCharacter = reportedSequenceCharacter(key.sequence);
  let character = sequenceCharacter ?? singleCharacter(key.name);
  if (character === null) return "preserve";
  if (key.shift && sequenceCharacter === null) character = shiftedAscii(character);
  if (UNSHIFTED_ASCII[character] !== undefined) return "shifted";
  if (/^[A-Z]$/u.test(character)) return "shifted";
  if (/^[a-z]$/u.test(character)) return "unshifted";
  if (UNSHIFTED_LEVEL_ASCII.includes(character)) return "unshifted";
  return "preserve";
}

function reportedSequenceCharacter(sequence: string | undefined): string | null {
  if (sequence === undefined) return null;
  const characters = [...sequence];
  return characters.length === 1 && isPrintableCharacter(characters[0]!) ? characters[0]! : null;
}

function singleCharacter(value: string): string | null {
  const characters = [...value];
  return characters.length === 1 ? characters[0]! : null;
}

function isPrintableCharacter(character: string): boolean {
  const codepoint = character.codePointAt(0);
  return codepoint !== undefined && codepoint >= 0x20 && codepoint !== 0x7f;
}

function keysymForCharacter(character: string): bigint | null {
  const codepoint = character.codePointAt(0);
  if (codepoint === undefined || codepoint < 0x20 || codepoint === 0x7f) return null;
  if (codepoint <= 0xff) return BigInt(codepoint);
  return 0x0100_0000n | BigInt(codepoint);
}
