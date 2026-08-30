const std = @import("std");
const input_state = @import("input_state.zig");

pub const Kind = enum(u32) {
    move,
    button,
    scroll,
    key,
    paste,
};

pub const kind_count = std.meta.fields(Kind).len;

pub const Counts = struct {
    values: [kind_count]u64 = [_]u64{0} ** kind_count,

    pub fn add(self: *Counts, kind: Kind, amount: u64) void {
        self.values[@intFromEnum(kind)] += amount;
    }

    pub fn merge(self: *Counts, other: Counts) void {
        for (&self.values, other.values) |*value, amount| value.* += amount;
    }

    pub fn get(self: *const Counts, kind: Kind) u64 {
        return self.values[@intFromEnum(kind)];
    }
};

pub const StateChange = union(enum) {
    button: struct { button: u3, pressed: bool },
    key: struct { keysym: u64, pressed: bool },
};

pub const Event = union(enum) {
    move: struct { x: u16, y: u16 },
    button: struct { button: u3, pressed: bool },
    scroll: struct { delta_x: i16, delta_y: i16, control_key: bool },
    key: struct { keysym: u64, pressed: bool },
    paste: []u8,

    pub fn deinit(self: *Event, allocator: std.mem.Allocator) void {
        switch (self.*) {
            .paste => |text| allocator.free(text),
            else => {},
        }
        self.* = undefined;
    }

    pub fn kind(self: Event) Kind {
        return switch (self) {
            .move => .move,
            .button => .button,
            .scroll => .scroll,
            .key => .key,
            .paste => .paste,
        };
    }

    pub fn stateChange(self: Event) ?StateChange {
        return switch (self) {
            .button => |button| .{ .button = .{
                .button = button.button,
                .pressed = button.pressed,
            } },
            .key => |key| .{ .key = .{
                .keysym = key.keysym,
                .pressed = key.pressed,
            } },
            else => null,
        };
    }

    pub fn applyDesired(self: Event, state: *input_state.InputState) !void {
        const change = self.stateChange() orelse return;
        try applyChange(change, state);
    }
};

pub fn changeNeeded(change: StateChange, state: *const input_state.InputState) bool {
    return switch (change) {
        .button => |button| state.isButtonHeld(button.button) != button.pressed,
        .key => |key| state.isKeyHeld(key.keysym) != key.pressed,
    };
}

pub fn applyChange(change: StateChange, state: *input_state.InputState) !void {
    switch (change) {
        .button => |button| {
            if (button.pressed) state.pressButton(button.button) else state.releaseButton(button.button);
        },
        .key => |key| {
            if (key.pressed) {
                _ = try state.pressKey(key.keysym);
            } else {
                _ = state.releaseKey(key.keysym);
            }
        },
    }
}

pub fn isDown(change: StateChange) bool {
    return switch (change) {
        .button => |button| button.pressed,
        .key => |key| key.pressed,
    };
}

test "events expose stable kinds and apply desired held state" {
    var state: input_state.InputState = .{};
    const down: Event = .{ .key = .{ .keysym = 'x', .pressed = true } };
    try std.testing.expectEqual(Kind.key, down.kind());
    try std.testing.expect(changeNeeded(down.stateChange().?, &state));
    try down.applyDesired(&state);
    try std.testing.expect(state.isKeyHeld('x'));
    try std.testing.expect(!changeNeeded(down.stateChange().?, &state));
}
