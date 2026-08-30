const std = @import("std");
const input_state = @import("input_state.zig");

pub const max_events = 32;
pub const max_age_ns = 2 * std.time.ns_per_s;
pub const max_paste_bytes = 1024 * 1024;

pub const Event = union(enum) {
    move: struct { x: u16, y: u16 },
    button: struct { button: u3, pressed: bool },
    scroll: struct { delta_x: i16, delta_y: i16, control_key: bool },
    key: struct { keysym: u64, pressed: bool, repeat: bool },
    paste: []u8,

    pub fn deinit(self: *Event, allocator: std.mem.Allocator) void {
        switch (self.*) {
            .paste => |text| allocator.free(text),
            else => {},
        }
        self.* = undefined;
    }
};

pub const PushResult = enum {
    queued,
    coalesced,
    duplicate,
    overflow,
    aborted,
    out_of_memory,

    pub fn accepted(self: PushResult) bool {
        return self == .queued or self == .coalesced;
    }
};

pub const Queue = struct {
    events: [max_events]Event = undefined,
    count: usize = 0,
    paste_bytes: usize = 0,
    first_queued_ns: ?i128 = null,
    aborted: bool = false,
    desired_input: input_state.InputState = .{},

    pub fn len(self: *const Queue) usize {
        return self.count;
    }

    pub fn isKeyHeld(self: *const Queue, keysym: u64) bool {
        return self.desired_input.isKeyHeld(keysym);
    }

    pub fn expire(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) bool {
        const started = self.first_queued_ns orelse return false;
        if (now_ns < started or now_ns - started < max_age_ns) return false;
        self.clear(allocator);
        return true;
    }

    pub fn pushMove(self: *Queue, allocator: std.mem.Allocator, x: u16, y: u16, now_ns: i128) PushResult {
        if (self.aborted) return .aborted;
        if (self.count > 0) {
            switch (self.events[self.count - 1]) {
                .move => {
                    self.events[self.count - 1] = .{ .move = .{ .x = x, .y = y } };
                    return .coalesced;
                },
                else => {},
            }
        }
        if (!self.reserve(allocator, now_ns)) return .overflow;
        self.append(.{ .move = .{ .x = x, .y = y } }, now_ns);
        return .queued;
    }

    pub fn pushButton(self: *Queue, allocator: std.mem.Allocator, button: u3, pressed: bool, now_ns: i128) PushResult {
        if (self.aborted) return .aborted;
        if (!self.reserve(allocator, now_ns)) return .overflow;
        if (pressed) self.desired_input.pressButton(button) else self.desired_input.releaseButton(button);
        self.append(.{ .button = .{ .button = button, .pressed = pressed } }, now_ns);
        return .queued;
    }

    pub fn pushScroll(self: *Queue, allocator: std.mem.Allocator, delta_x: i16, delta_y: i16, control_key: bool, now_ns: i128) PushResult {
        if (self.aborted) return .aborted;
        if (self.count > 0) {
            switch (self.events[self.count - 1]) {
                .scroll => |previous| {
                    if (previous.control_key == control_key) {
                        self.events[self.count - 1] = .{ .scroll = .{
                            .delta_x = previous.delta_x +| delta_x,
                            .delta_y = previous.delta_y +| delta_y,
                            .control_key = control_key,
                        } };
                        return .coalesced;
                    }
                },
                else => {},
            }
        }
        if (!self.reserve(allocator, now_ns)) return .overflow;
        self.append(.{ .scroll = .{
            .delta_x = delta_x,
            .delta_y = delta_y,
            .control_key = control_key,
        } }, now_ns);
        return .queued;
    }

    pub fn pushKey(self: *Queue, allocator: std.mem.Allocator, keysym: u64, pressed: bool, repeat: bool, now_ns: i128) PushResult {
        if (self.aborted) return .aborted;
        if (pressed) {
            // Neko debounces repeated key-down packets and X provides repeat
            // after the original down is replayed, so retaining repeat events
            // only consumes the bounded admission queue.
            if (self.desired_input.isKeyHeld(keysym)) return .duplicate;
        } else if (!self.desired_input.isKeyHeld(keysym)) {
            return .duplicate;
        }
        if (!self.reserve(allocator, now_ns)) return .overflow;
        if (pressed) {
            if (!self.desired_input.isKeyHeld(keysym)) {
                _ = self.desired_input.pressKey(keysym) catch {
                    self.abort(allocator, now_ns);
                    return .overflow;
                };
            }
        } else {
            _ = self.desired_input.releaseKey(keysym);
        }
        self.append(.{ .key = .{
            .keysym = keysym,
            .pressed = pressed,
            .repeat = repeat,
        } }, now_ns);
        return .queued;
    }

    pub fn pushPaste(self: *Queue, allocator: std.mem.Allocator, text: []const u8, now_ns: i128) PushResult {
        if (self.aborted) return .aborted;
        if (text.len > max_paste_bytes -| self.paste_bytes) {
            return .overflow;
        }
        if (!self.reserve(allocator, now_ns)) return .overflow;
        const copy = allocator.dupe(u8, text) catch {
            return .out_of_memory;
        };
        self.paste_bytes += copy.len;
        self.append(.{ .paste = copy }, now_ns);
        return .queued;
    }

    pub fn pop(self: *Queue) ?Event {
        if (self.count == 0) return null;
        const event = self.events[0];
        switch (event) {
            .paste => |text| self.paste_bytes -= text.len,
            else => {},
        }
        for (1..self.count) |index| self.events[index - 1] = self.events[index];
        self.count -= 1;
        if (self.count == 0) self.resetQueueMetadata();
        return event;
    }

    pub fn takeBatch(self: *Queue, output: *[max_events]Event) usize {
        const length = self.count;
        @memcpy(output[0..length], self.events[0..length]);
        self.count = 0;
        self.resetQueueMetadata();
        return length;
    }

    pub fn finishReplay(self: *Queue) void {
        std.debug.assert(self.count == 0);
        self.resetQueueMetadata();
        self.desired_input.clear();
    }

    pub fn clear(self: *Queue, allocator: std.mem.Allocator) void {
        for (self.events[0..self.count]) |*event| event.deinit(allocator);
        self.count = 0;
        self.resetMetadata();
    }

    fn reserve(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) bool {
        if (self.count < self.events.len) return true;
        self.abort(allocator, now_ns);
        return false;
    }

    fn append(self: *Queue, event: Event, now_ns: i128) void {
        if (self.first_queued_ns == null) self.first_queued_ns = now_ns;
        self.events[self.count] = event;
        self.count += 1;
    }

    fn abort(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) void {
        self.clear(allocator);
        self.aborted = true;
        self.first_queued_ns = now_ns;
    }

    fn resetMetadata(self: *Queue) void {
        self.resetQueueMetadata();
        self.desired_input.clear();
    }

    fn resetQueueMetadata(self: *Queue) void {
        self.paste_bytes = 0;
        self.first_queued_ns = null;
        self.aborted = false;
    }
};

test "first semantic input is retained for replay" {
    var queue: Queue = .{};
    defer queue.clear(std.testing.allocator);

    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 'a', true, false, 10));
    try std.testing.expect(queue.isKeyHeld('a'));
    var event = queue.pop().?;
    defer event.deinit(std.testing.allocator);
    try std.testing.expectEqual(@as(usize, 0), queue.len());
    try std.testing.expect(queue.isKeyHeld('a'));
    queue.finishReplay();
    try std.testing.expect(!queue.isKeyHeld('a'));
    switch (event) {
        .key => |key| {
            try std.testing.expectEqual(@as(u64, 'a'), key.keysym);
            try std.testing.expect(key.pressed);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "motion coalesces only within semantic ordering barriers" {
    var queue: Queue = .{};
    defer queue.clear(std.testing.allocator);

    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 1, 2, 10));
    try std.testing.expectEqual(.coalesced, queue.pushMove(std.testing.allocator, 3, 4, 11));
    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 'x', true, false, 12));
    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 5, 6, 13));
    try std.testing.expectEqual(.coalesced, queue.pushMove(std.testing.allocator, 7, 8, 14));
    try std.testing.expectEqual(@as(usize, 3), queue.len());

    var first = queue.pop().?;
    defer first.deinit(std.testing.allocator);
    switch (first) {
        .move => |position| {
            try std.testing.expectEqual(@as(u16, 3), position.x);
            try std.testing.expectEqual(@as(u16, 4), position.y);
        },
        else => return error.TestUnexpectedResult,
    }
    var barrier = queue.pop().?;
    defer barrier.deinit(std.testing.allocator);
    try std.testing.expect(barrier == .key);
    var last = queue.pop().?;
    defer last.deinit(std.testing.allocator);
    switch (last) {
        .move => |position| {
            try std.testing.expectEqual(@as(u16, 7), position.x);
            try std.testing.expectEqual(@as(u16, 8), position.y);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "compatible scroll bursts coalesce and keys still form barriers" {
    var queue: Queue = .{};
    defer queue.clear(std.testing.allocator);

    try std.testing.expectEqual(.queued, queue.pushScroll(std.testing.allocator, 10, 20, false, 10));
    try std.testing.expectEqual(.coalesced, queue.pushScroll(std.testing.allocator, 30, -5, false, 11));
    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 'x', true, false, 12));
    try std.testing.expectEqual(.queued, queue.pushScroll(std.testing.allocator, 1, 2, false, 13));
    try std.testing.expectEqual(.queued, queue.pushScroll(std.testing.allocator, 3, 4, true, 14));
    try std.testing.expectEqual(@as(usize, 4), queue.len());

    var first = queue.pop().?;
    defer first.deinit(std.testing.allocator);
    switch (first) {
        .scroll => |scroll| {
            try std.testing.expectEqual(@as(i16, 40), scroll.delta_x);
            try std.testing.expectEqual(@as(i16, 15), scroll.delta_y);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "repeat downs do not consume the bounded queue" {
    var queue: Queue = .{};
    defer queue.clear(std.testing.allocator);

    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 'x', true, false, 10));
    for (0..max_events * 2) |_| {
        try std.testing.expectEqual(.duplicate, queue.pushKey(std.testing.allocator, 'x', true, true, 11));
    }
    try std.testing.expectEqual(@as(usize, 1), queue.len());
}

test "overflow abandons the entire pending batch until its time bound" {
    var queue: Queue = .{};
    defer queue.clear(std.testing.allocator);

    for (0..max_events) |index| {
        try std.testing.expectEqual(.queued, queue.pushScroll(
            std.testing.allocator,
            @intCast(index),
            0,
            index % 2 != 0,
            10,
        ));
    }
    try std.testing.expectEqual(.overflow, queue.pushKey(std.testing.allocator, 'z', true, false, 11));
    try std.testing.expectEqual(@as(usize, 0), queue.len());
    try std.testing.expectEqual(.aborted, queue.pushMove(std.testing.allocator, 9, 9, 12));
    try std.testing.expect(queue.expire(std.testing.allocator, 11 + max_age_ns));
    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 9, 9, 12 + max_age_ns));
}

test "clear discards owned paste and desired held state" {
    var queue: Queue = .{};
    try std.testing.expectEqual(.queued, queue.pushPaste(std.testing.allocator, "clipboard", 10));
    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 'v', true, false, 11));
    queue.clear(std.testing.allocator);

    try std.testing.expectEqual(@as(usize, 0), queue.len());
    try std.testing.expect(!queue.isKeyHeld('v'));
    try std.testing.expectEqual(@as(usize, 0), queue.paste_bytes);
}
