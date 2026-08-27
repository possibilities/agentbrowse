const std = @import("std");

pub const Opcode = enum(u8) {
    move = 0x01,
    scroll = 0x02,
    key_down = 0x03,
    key_up = 0x04,
};

pub const KeyAction = enum { down, up };

pub fn move(x: u16, y: u16) [7]u8 {
    var packet: [7]u8 = undefined;
    packet[0] = @intFromEnum(Opcode.move);
    std.mem.writeInt(u16, packet[1..3], 4, .little);
    std.mem.writeInt(u16, packet[3..5], x, .little);
    std.mem.writeInt(u16, packet[5..7], y, .little);
    return packet;
}

pub fn scroll(dx: i16, dy: i16, control_key: bool) [8]u8 {
    var packet: [8]u8 = undefined;
    packet[0] = @intFromEnum(Opcode.scroll);
    std.mem.writeInt(u16, packet[1..3], 5, .little);
    std.mem.writeInt(i16, packet[3..5], dx, .little);
    std.mem.writeInt(i16, packet[5..7], dy, .little);
    packet[7] = @intFromBool(control_key);
    return packet;
}

pub fn key(opcode: KeyAction, keysym: u64) [11]u8 {
    var packet: [11]u8 = undefined;
    packet[0] = @intFromEnum(if (opcode == .down) Opcode.key_down else Opcode.key_up);
    std.mem.writeInt(u16, packet[1..3], 8, .little);
    std.mem.writeInt(u64, packet[3..11], keysym, .little);
    return packet;
}

pub fn mouseButton(opcode: KeyAction, browser_button: u8) [11]u8 {
    return key(opcode, @as(u64, browser_button) + 1);
}

test "golden input packets" {
    try std.testing.expectEqualSlices(u8, &.{ 0x01, 0x04, 0x00, 0x34, 0x12, 0xcd, 0xab }, &move(0x1234, 0xabcd));
    try std.testing.expectEqualSlices(u8, &.{ 0x02, 0x05, 0x00, 0xff, 0xff, 0x02, 0x00, 0x01 }, &scroll(-1, 2, true));
    try std.testing.expectEqualSlices(u8, &.{ 0x03, 0x08, 0x00, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0 }, &key(.down, 0xffff_ffff));
    try std.testing.expectEqualSlices(u8, &.{ 0x04, 0x08, 0x00, 0x03, 0, 0, 0, 0, 0, 0, 0 }, &mouseButton(.up, 2));
}
