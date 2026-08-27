const std = @import("std");

pub const Modifier = struct {
    flag: u64,
    left_keysym: u64,
    right_keysym: u64,
};

pub const modifiers = [_]Modifier{
    .{ .flag = 1 << 17, .left_keysym = 0xffe1, .right_keysym = 0xffe2 }, // Shift
    .{ .flag = 1 << 18, .left_keysym = 0xffe3, .right_keysym = 0xffe4 }, // Control
    .{ .flag = 1 << 19, .left_keysym = 0xffe9, .right_keysym = 0xffea }, // Option -> Alt
    .{ .flag = 1 << 20, .left_keysym = 0xffe7, .right_keysym = 0xffe8 }, // Command -> Meta
};

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
