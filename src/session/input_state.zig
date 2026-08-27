const std = @import("std");

pub const max_held_keys = 64;

pub const InputState = struct {
    keys: [max_held_keys]u64 = [_]u64{0} ** max_held_keys,
    key_count: usize = 0,
    buttons: u8 = 0,

    pub fn pressKey(self: *InputState, keysym: u64) !bool {
        for (self.keys[0..self.key_count]) |held| if (held == keysym) return false;
        if (self.key_count == self.keys.len) return error.TooManyHeldKeys;
        self.keys[self.key_count] = keysym;
        self.key_count += 1;
        return true;
    }

    pub fn isKeyHeld(self: *const InputState, keysym: u64) bool {
        for (self.keys[0..self.key_count]) |held| if (held == keysym) return true;
        return false;
    }

    pub fn releaseKey(self: *InputState, keysym: u64) bool {
        for (self.keys[0..self.key_count], 0..) |held, index| {
            if (held != keysym) continue;
            self.key_count -= 1;
            self.keys[index] = self.keys[self.key_count];
            return true;
        }
        return false;
    }

    pub fn pressButton(self: *InputState, button: u3) void {
        self.buttons |= @as(u8, 1) << button;
    }

    pub fn releaseButton(self: *InputState, button: u3) void {
        self.buttons &= ~(@as(u8, 1) << button);
    }

    pub fn clear(self: *InputState) void {
        self.key_count = 0;
        self.buttons = 0;
    }
};

test "held input is idempotent and clears" {
    var state: InputState = .{};
    try std.testing.expect(try state.pressKey(0xffe1));
    try std.testing.expect(!(try state.pressKey(0xffe1)));
    state.pressButton(0);
    try std.testing.expect(state.releaseKey(0xffe1));
    state.clear();
    try std.testing.expectEqual(@as(usize, 0), state.key_count);
    try std.testing.expectEqual(@as(u8, 0), state.buttons);
}
