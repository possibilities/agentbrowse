const std = @import("std");
const physical_key_state = @import("../../session/physical_key_state.zig");

pub const shift_flag: u64 = 1 << 17;
pub const caps_lock_flag: u64 = 1 << 16;
pub const control_flag: u64 = 1 << 18;
pub const option_flag: u64 = 1 << 19;
pub const command_flag: u64 = 1 << 20;

pub const Modifier = struct {
    flag: u64,
    left_keysym: u64,
    right_keysym: u64,
};

pub const modifiers = [_]Modifier{
    .{ .flag = shift_flag, .left_keysym = 0xffe1, .right_keysym = 0xffe2 }, // Shift
    .{ .flag = control_flag, .left_keysym = 0xffe3, .right_keysym = 0xffe4 }, // Control
    .{ .flag = option_flag, .left_keysym = 0xffe9, .right_keysym = 0xffea }, // Option -> Alt
    .{ .flag = command_flag, .left_keysym = 0xffe7, .right_keysym = 0xffe8 }, // Command -> Meta
};

pub fn shortcutTranslation(
    key_code: u16,
    flags: u64,
    characters: []const u8,
) ?physical_key_state.Target {
    const command = (flags & command_flag) != 0;
    const option = (flags & option_flag) != 0;
    if (command and !option) {
        // Navigation chords match the keycode rather than the reported
        // character so they survive non-US layouts. The forced Option flag
        // reaches the guest as X11 Alt through `modifiers`, which is Linux
        // Chrome's history-navigation modifier.
        const navigation: ?struct { keysym: u64, forced: u64 } = switch (key_code) {
            123 => .{ .keysym = 0xff50, .forced = 0 }, // Left -> Home
            124 => .{ .keysym = 0xff57, .forced = 0 }, // Right -> End
            125 => .{ .keysym = 0xff57, .forced = control_flag }, // Down -> Control-End
            126 => .{ .keysym = 0xff50, .forced = control_flag }, // Up -> Control-Home
            33 => .{ .keysym = 0xff51, .forced = option_flag }, // [ -> Alt-Left (back)
            30 => .{ .keysym = 0xff53, .forced = option_flag }, // ] -> Alt-Right (forward)
            else => null,
        };
        if (navigation) |target| return .{
            .physical_id = key_code,
            .keysym = target.keysym,
            .removed_modifiers = command_flag,
            .forced_modifiers = target.forced | (flags & shift_flag),
        };
        const shifted = (flags & shift_flag) != 0;
        const target: u64 = switch (key_code) {
            24 => if (shifted) '+' else '=',
            27 => if (shifted) '_' else '-',
            29 => if (shifted) ')' else '0',
            else => commandShortcutKeysym(characters, shifted) orelse return null,
        };
        return .{
            .physical_id = key_code,
            .keysym = target,
            .removed_modifiers = command_flag,
            .forced_modifiers = control_flag | (flags & shift_flag),
        };
    }
    if (option and !command) {
        // macOS moves and deletes by word with Option; Linux Chrome uses Control.
        const editing: ?u64 = switch (key_code) {
            123 => 0xff51, // Left -> Control-Left
            124 => 0xff53, // Right -> Control-Right
            51 => 0xff08, // Backspace -> Control-BackSpace
            117 => 0xffff, // Forward Delete -> Control-Delete
            else => null,
        };
        if (editing) |target| return .{
            .physical_id = key_code,
            .keysym = target,
            .removed_modifiers = option_flag,
            .forced_modifiers = control_flag | (flags & shift_flag),
        };
    }
    return null;
}

/// Command chords that become the guest's Control chords. W, N, P, and D are
/// deliberately absent: Control-W closes the guest tab, and on a single-tab
/// Kernel Chromium that exits the browser and the session; Control-N opens a
/// guest window, Control-P a modal print dialog, and Control-D a bookmark
/// bubble. An untranslated Command chord still reaches the guest as a
/// harmless Meta chord.
fn commandShortcutKeysym(characters: []const u8, shifted: bool) ?u64 {
    if (characters.len != 1 or !std.ascii.isAscii(characters[0])) return null;
    return switch (std.ascii.toLower(characters[0])) {
        'a', 'c', 'f', 'l', 'r', 't', 'x', 'z' => if (shifted)
            std.ascii.toUpper(characters[0])
        else
            std.ascii.toLower(characters[0]),
        '-', '_' => if (shifted) '_' else '-',
        '0', ')' => if (shifted) ')' else '0',
        '=', '+' => if (shifted) '+' else '=',
        else => null,
    };
}

/// Build an exact printable target at the guest's US-XKB level. AppKit can
/// report an uppercase character because Caps Lock is active even though the
/// physical Shift flag is clear (and the inverse for Caps+Shift). Choosing the
/// level from the reported keysym prevents Neko from allocating a spare
/// keycode when its current Shift state cannot produce that keysym.
pub fn physicalTarget(physical_id: u32, keysym_value: u64) physical_key_state.Target {
    const level = guestShiftLevel(keysym_value);
    return .{
        .physical_id = physical_id,
        .keysym = keysym_value,
        .removed_modifiers = if (level == .unshifted) shift_flag else 0,
        .forced_modifiers = if (level == .shifted) shift_flag else 0,
    };
}

const GuestShiftLevel = enum { preserve, unshifted, shifted };

fn guestShiftLevel(keysym_value: u64) GuestShiftLevel {
    if (keysym_value >= 'A' and keysym_value <= 'Z') return .shifted;
    if (keysym_value >= 'a' and keysym_value <= 'z') return .unshifted;
    // Non-Latin keysyms have no guest US-XKB level to infer. Preserving the
    // physical level leaves Neko's dynamic mapping bounded by distinct
    // symbols rather than allocating a new keycode on every repeated press.
    if (keysym_value > std.math.maxInt(u8)) return .preserve;
    const character: u8 = @intCast(keysym_value);
    if (std.mem.indexOfScalar(u8, "~!@#$%^&*()_+{}|:\"<>?", character) != null) return .shifted;
    if (std.mem.indexOfScalar(u8, "`1234567890-=[]\\;',./", character) != null) return .unshifted;
    return .preserve;
}

pub fn keysym(key_code: u16, characters: []const u8) ?u64 {
    if (special(key_code)) |value| return value;
    if (characters.len == 0) return null;
    const sequence_len = std.unicode.utf8ByteSequenceLength(characters[0]) catch return null;
    if (sequence_len > characters.len) return null;
    const scalar = std.unicode.utf8Decode(characters[0..sequence_len]) catch return null;
    if (scalar <= 0xff) return scalar;
    return 0x0100_0000 | @as(u64, scalar);
}

pub fn isModifierKey(key_code: u16) bool {
    return switch (key_code) {
        54, 55, 56, 58, 59, 60, 61, 62 => true,
        else => false,
    };
}

fn special(key_code: u16) ?u64 {
    return switch (key_code) {
        36 => 0xff0d, // Return
        48 => 0xff09, // Tab
        49 => 0x0020, // Space
        51 => 0xff08, // Backspace
        53 => 0xff1b, // Escape
        54 => 0xffe8, // Command_R -> Meta_R
        55 => 0xffe7, // Command_L -> Meta_L
        56 => 0xffe1, // Shift_L
        57 => 0xffe5, // Caps Lock
        58 => 0xffe9, // Option_L -> Alt_L
        59 => 0xffe3, // Control_L
        60 => 0xffe2, // Shift_R
        61 => 0xffea, // Option_R -> Alt_R
        62 => 0xffe4, // Control_R
        71 => 0xff7f, // Clear
        76 => 0xff8d, // Keypad Enter
        114 => 0xff63, // Insert/Help
        115 => 0xff50, // Home
        116 => 0xff55, // Page Up
        117 => 0xffff, // Forward Delete
        119 => 0xff57, // End
        121 => 0xff56, // Page Down
        123 => 0xff51, // Left
        124 => 0xff53, // Right
        125 => 0xff54, // Down
        126 => 0xff52, // Up
        122 => 0xffbe, // F1
        120 => 0xffbf,
        99 => 0xffc0,
        118 => 0xffc1,
        96 => 0xffc2,
        97 => 0xffc3,
        98 => 0xffc4,
        100 => 0xffc5,
        101 => 0xffc6,
        109 => 0xffc7,
        103 => 0xffc8,
        111 => 0xffc9, // F12
        else => null,
    };
}

test "maps AppKit keys to X keysyms" {
    try std.testing.expectEqual(@as(?u64, 0xff51), keysym(123, ""));
    try std.testing.expectEqual(@as(?u64, 'a'), keysym(0, "a"));
    try std.testing.expectEqual(@as(?u64, 0x0100_03bb), keysym(0, "λ"));
}

test "identifies AppKit modifier keys" {
    try std.testing.expect(isModifierKey(59));
    try std.testing.expect(isModifierKey(62));
    try std.testing.expect(!isModifierKey(37));
    try std.testing.expectEqual(@as(u64, 1 << 18), modifiers[1].flag);
}

test "translates AppKit browser shortcuts and preserves navigation semantics" {
    for ("cxazltrf") |character| {
        const characters = [_]u8{character};
        const translation = shortcutTranslation(8, command_flag, &characters).?;
        try std.testing.expectEqual(@as(u64, character), translation.keysym);
        try std.testing.expectEqual(control_flag, translation.forced_modifiers);
    }
    // Control-W/N/P/D would close the tab (and a single-tab session), open a
    // window, print, or bookmark in the guest; they stay untranslated Meta.
    for ("wnpdWNPD") |character| {
        const characters = [_]u8{character};
        try std.testing.expect(shortcutTranslation(8, command_flag, &characters) == null);
        try std.testing.expect(shortcutTranslation(8, command_flag | shift_flag, &characters) == null);
    }

    const command_c = shortcutTranslation(8, command_flag | shift_flag, "C").?;
    try std.testing.expectEqual(@as(u64, 'C'), command_c.keysym);
    try std.testing.expectEqual(command_flag, command_c.removed_modifiers);
    try std.testing.expectEqual(control_flag | shift_flag, command_c.forced_modifiers);
    try std.testing.expectEqual(@as(u64, 'Z'), shortcutTranslation(6, command_flag | shift_flag, "Z").?.keysym);
    try std.testing.expectEqual(@as(u64, '+'), shortcutTranslation(24, command_flag | shift_flag, "+").?.keysym);
    try std.testing.expectEqual(@as(u64, '='), shortcutTranslation(24, command_flag | caps_lock_flag, "+").?.keysym);

    const caps_command_c = shortcutTranslation(8, command_flag | caps_lock_flag, "C").?;
    try std.testing.expectEqual(@as(u64, 'c'), caps_command_c.keysym);
    try std.testing.expectEqual(control_flag, caps_command_c.forced_modifiers);
    const caps_shift_command_z = shortcutTranslation(6, command_flag | caps_lock_flag | shift_flag, "z").?;
    try std.testing.expectEqual(@as(u64, 'Z'), caps_shift_command_z.keysym);
    try std.testing.expectEqual(control_flag | shift_flag, caps_shift_command_z.forced_modifiers);

    const home = shortcutTranslation(123, command_flag, "").?;
    try std.testing.expectEqual(@as(u64, 0xff50), home.keysym);
    try std.testing.expectEqual(@as(u64, 0), home.forced_modifiers);
    const control_home = shortcutTranslation(126, command_flag, "").?;
    try std.testing.expectEqual(@as(u64, 0xff50), control_home.keysym);
    try std.testing.expectEqual(control_flag, control_home.forced_modifiers);

    const control_left = shortcutTranslation(123, option_flag, "").?;
    try std.testing.expectEqual(@as(u64, 0xff51), control_left.keysym);
    try std.testing.expectEqual(option_flag, control_left.removed_modifiers);

    const back = shortcutTranslation(33, command_flag, "[").?;
    try std.testing.expectEqual(@as(u64, 0xff51), back.keysym);
    try std.testing.expectEqual(command_flag, back.removed_modifiers);
    try std.testing.expectEqual(option_flag, back.forced_modifiers);
    const forward = shortcutTranslation(30, command_flag | shift_flag, "}").?;
    try std.testing.expectEqual(@as(u64, 0xff53), forward.keysym);
    try std.testing.expectEqual(option_flag | shift_flag, forward.forced_modifiers);
    try std.testing.expect(shortcutTranslation(33, command_flag | option_flag, "[") == null);
    try std.testing.expect(shortcutTranslation(33, option_flag, "[") == null);

    const word_backspace = shortcutTranslation(51, option_flag, "").?;
    try std.testing.expectEqual(@as(u64, 0xff08), word_backspace.keysym);
    try std.testing.expectEqual(option_flag, word_backspace.removed_modifiers);
    try std.testing.expectEqual(control_flag, word_backspace.forced_modifiers);
    const word_delete = shortcutTranslation(117, option_flag | shift_flag, "").?;
    try std.testing.expectEqual(@as(u64, 0xffff), word_delete.keysym);
    try std.testing.expectEqual(option_flag, word_delete.removed_modifiers);
    try std.testing.expectEqual(control_flag | shift_flag, word_delete.forced_modifiers);
    try std.testing.expect(shortcutTranslation(51, command_flag, "") == null);
    try std.testing.expect(shortcutTranslation(117, command_flag | option_flag, "") == null);
    try std.testing.expect(shortcutTranslation(12, command_flag, "q") == null);
    try std.testing.expect(shortcutTranslation(9, command_flag, "v") == null);
}

test "selects the guest XKB level from AppKit's reported character" {
    const caps_upper = physicalTarget(8, 'C');
    try std.testing.expectEqual(@as(u64, shift_flag), caps_upper.forced_modifiers);
    try std.testing.expectEqual(@as(u64, 0), caps_upper.removed_modifiers);

    const caps_shift_lower = physicalTarget(6, 'z');
    try std.testing.expectEqual(@as(u64, 0), caps_shift_lower.forced_modifiers);
    try std.testing.expectEqual(@as(u64, shift_flag), caps_shift_lower.removed_modifiers);

    const shifted_symbol = physicalTarget(24, '+');
    try std.testing.expectEqual(@as(u64, shift_flag), shifted_symbol.forced_modifiers);
    const special_target = physicalTarget(123, 0xff51);
    try std.testing.expectEqual(@as(u64, 0), special_target.forced_modifiers);
    try std.testing.expectEqual(@as(u64, 0), special_target.removed_modifiers);
}
