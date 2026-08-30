const std = @import("std");

pub const capacity = 32;

/// The guest target chosen when one physical key was pressed. Keeping the
/// target until key-up makes releases independent of later modifier changes
/// and lets translated chords restore their own effective modifier level.
pub const Target = struct {
    physical_id: u32,
    keysym: u64,
    removed_modifiers: u64 = 0,
    forced_modifiers: u64 = 0,
};

pub const ModifierTransform = struct {
    removed: u64 = 0,
    forced: u64 = 0,

    pub fn apply(self: ModifierTransform, physical: u64) u64 {
        return (physical & ~self.removed) | self.forced;
    }
};

pub const State = struct {
    entries: [capacity]Target = undefined,
    count: u8 = 0,

    pub fn remember(self: *State, target: Target) bool {
        if (self.find(target.physical_id)) |index| {
            self.entries[index] = target;
            return true;
        }
        if (self.count == capacity) return false;
        self.entries[self.count] = target;
        self.count += 1;
        return true;
    }

    pub fn get(self: *const State, physical_id: u32) ?Target {
        const index = self.find(physical_id) orelse return null;
        return self.entries[index];
    }

    pub fn take(self: *State, physical_id: u32) ?Target {
        const index = self.find(physical_id) orelse return null;
        const target = self.entries[index];
        self.count -= 1;
        if (index != self.count) self.entries[index] = self.entries[self.count];
        return target;
    }

    pub fn hasActive(self: *const State) bool {
        return self.count != 0;
    }

    pub fn clear(self: *State) void {
        self.count = 0;
    }

    fn find(self: *const State, physical_id: u32) ?u8 {
        for (self.entries[0..self.count], 0..) |target, index| {
            if (target.physical_id == physical_id) return @intCast(index);
        }
        return null;
    }
};

test "physical key state preserves targets until release" {
    var state: State = .{};
    try std.testing.expect(state.remember(.{
        .physical_id = 8,
        .keysym = 'C',
        .removed_modifiers = 1 << 20,
        .forced_modifiers = (1 << 18) | (1 << 17),
    }));
    try std.testing.expect(state.remember(.{
        .physical_id = 123,
        .keysym = 0xff51,
        .removed_modifiers = 1 << 19,
        .forced_modifiers = 1 << 18,
    }));
    const command_c = state.get(8).?;
    try std.testing.expectEqual(@as(u64, 'C'), command_c.keysym);
    try std.testing.expectEqual(
        @as(u64, (1 << 17) | (1 << 18)),
        (ModifierTransform{
            .removed = command_c.removed_modifiers,
            .forced = command_c.forced_modifiers,
        }).apply((1 << 17) | (1 << 20)),
    );
    try std.testing.expectEqual(@as(?u64, 'C'), if (state.take(8)) |entry| entry.keysym else null);
    try std.testing.expect(state.hasActive());
    state.clear();
    try std.testing.expect(!state.hasActive());
}
