const std = @import("std");
const input_event = @import("input_event.zig");

pub const max_events = 256;
pub const max_waiting_events = 32;
pub const max_age_ns = 2 * std.time.ns_per_s;
pub const max_paste_bytes = 1024 * 1024;

pub const Event = input_event.Event;
pub const Counts = input_event.Counts;

pub const Entry = struct {
    sequence: u64,
    epoch: u64,
    event: Event,
};

pub const PushResult = enum {
    queued,
    coalesced,
    overflow,
    aborted,
    out_of_memory,

    pub fn accepted(self: PushResult) bool {
        return self == .queued or self == .coalesced;
    }
};

pub const PushOutcome = struct {
    result: PushResult,
    abandoned: Counts = .{},
    wait_duration_ns: ?i128 = null,

    pub fn accepted(self: PushOutcome) bool {
        return self.result.accepted();
    }
};

pub const ClearResult = struct {
    abandoned: Counts = .{},
    wait_duration_ns: ?i128 = null,
};

pub const Queue = struct {
    entries: [max_events]Entry = undefined,
    count: usize = 0,
    paste_bytes: usize = 0,
    wait_started_ns: ?i128 = null,
    aborted: bool = false,

    pub fn len(self: *const Queue) usize {
        return self.count;
    }

    pub fn capacity(self: *const Queue) usize {
        _ = self;
        return max_events;
    }

    pub fn entry(self: *const Queue, index: usize) *const Entry {
        std.debug.assert(index < self.count);
        return &self.entries[index];
    }

    pub fn isWaiting(self: *const Queue) bool {
        return self.wait_started_ns != null;
    }

    pub fn canAppend(self: *const Queue, amount: usize, waiting: bool) bool {
        if (waiting and self.aborted) return false;
        const limit: usize = if (waiting) max_waiting_events else max_events;
        return amount <= limit -| self.count;
    }

    pub fn expireWait(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) ?ClearResult {
        const started = self.wait_started_ns orelse return null;
        if (now_ns < started or now_ns - started < max_age_ns) return null;
        return self.clear(allocator, now_ns);
    }

    pub fn finishWait(self: *Queue, now_ns: i128) ?i128 {
        const duration = self.waitDuration(now_ns);
        self.wait_started_ns = null;
        self.aborted = false;
        return duration;
    }

    pub fn abortWait(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) ClearResult {
        const result = ClearResult{
            .abandoned = self.clearEntries(allocator),
            .wait_duration_ns = self.waitDuration(now_ns),
        };
        self.wait_started_ns = now_ns;
        self.aborted = true;
        return result;
    }

    pub fn pushMove(self: *Queue, allocator: std.mem.Allocator, sequence: u64, epoch: u64, x: u16, y: u16, waiting: bool, now_ns: i128) PushOutcome {
        if (waiting and self.aborted) return .{ .result = .aborted };
        if (self.count > 0) {
            const last = &self.entries[self.count - 1];
            if (last.epoch == epoch) switch (last.event) {
                .move => {
                    last.event = .{ .move = .{ .x = x, .y = y } };
                    return .{ .result = .coalesced };
                },
                else => {},
            };
        }
        if (self.reserve(allocator, waiting, now_ns)) |failure| return failure;
        self.append(.{ .sequence = sequence, .epoch = epoch, .event = .{ .move = .{ .x = x, .y = y } } }, waiting, now_ns);
        return .{ .result = .queued };
    }

    pub fn pushButton(self: *Queue, allocator: std.mem.Allocator, sequence: u64, epoch: u64, button: u3, pressed: bool, waiting: bool, now_ns: i128) PushOutcome {
        return self.pushSimple(allocator, .{
            .sequence = sequence,
            .epoch = epoch,
            .event = .{ .button = .{ .button = button, .pressed = pressed } },
        }, waiting, now_ns);
    }

    pub fn pushScroll(self: *Queue, allocator: std.mem.Allocator, sequence: u64, epoch: u64, delta_x: i16, delta_y: i16, control_key: bool, waiting: bool, now_ns: i128) PushOutcome {
        if (waiting and self.aborted) return .{ .result = .aborted };
        if (self.count > 0) {
            const last = &self.entries[self.count - 1];
            if (last.epoch == epoch) switch (last.event) {
                .scroll => |previous| {
                    if (previous.control_key == control_key) {
                        last.event = .{ .scroll = .{
                            .delta_x = previous.delta_x +| delta_x,
                            .delta_y = previous.delta_y +| delta_y,
                            .control_key = control_key,
                        } };
                        return .{ .result = .coalesced };
                    }
                },
                else => {},
            };
        }
        if (self.reserve(allocator, waiting, now_ns)) |failure| return failure;
        self.append(.{ .sequence = sequence, .epoch = epoch, .event = .{ .scroll = .{
            .delta_x = delta_x,
            .delta_y = delta_y,
            .control_key = control_key,
        } } }, waiting, now_ns);
        return .{ .result = .queued };
    }

    pub fn pushKey(self: *Queue, allocator: std.mem.Allocator, sequence: u64, epoch: u64, keysym: u64, pressed: bool, waiting: bool, now_ns: i128) PushOutcome {
        return self.pushSimple(allocator, .{
            .sequence = sequence,
            .epoch = epoch,
            .event = .{ .key = .{ .keysym = keysym, .pressed = pressed } },
        }, waiting, now_ns);
    }

    pub fn pushPaste(self: *Queue, allocator: std.mem.Allocator, sequence: u64, epoch: u64, text: []const u8, waiting: bool, now_ns: i128) PushOutcome {
        if (waiting and self.aborted) return .{ .result = .aborted };
        if (text.len > max_paste_bytes -| self.paste_bytes) return .{ .result = .overflow };
        if (self.reserve(allocator, waiting, now_ns)) |failure| return failure;
        const copy = allocator.dupe(u8, text) catch return .{ .result = .out_of_memory };
        self.paste_bytes += copy.len;
        self.append(.{
            .sequence = sequence,
            .epoch = epoch,
            .event = .{ .paste = copy },
        }, waiting, now_ns);
        return .{ .result = .queued };
    }

    pub fn pop(self: *Queue) ?Entry {
        if (self.count == 0) return null;
        const value = self.entries[0];
        switch (value.event) {
            .paste => |text| self.paste_bytes -= text.len,
            else => {},
        }
        for (1..self.count) |index| self.entries[index - 1] = self.entries[index];
        self.count -= 1;
        return value;
    }

    pub fn clear(self: *Queue, allocator: std.mem.Allocator, now_ns: i128) ClearResult {
        const result = ClearResult{
            .abandoned = self.clearEntries(allocator),
            .wait_duration_ns = self.waitDuration(now_ns),
        };
        self.wait_started_ns = null;
        self.aborted = false;
        return result;
    }

    fn pushSimple(self: *Queue, allocator: std.mem.Allocator, value: Entry, waiting: bool, now_ns: i128) PushOutcome {
        if (waiting and self.aborted) return .{ .result = .aborted };
        if (self.reserve(allocator, waiting, now_ns)) |failure| return failure;
        self.append(value, waiting, now_ns);
        return .{ .result = .queued };
    }

    fn reserve(self: *Queue, allocator: std.mem.Allocator, waiting: bool, now_ns: i128) ?PushOutcome {
        const limit: usize = if (waiting) max_waiting_events else max_events;
        if (self.count < limit) return null;
        if (!waiting) return .{ .result = .overflow };
        const abandoned = self.abortWait(allocator, now_ns);
        return .{
            .result = .overflow,
            .abandoned = abandoned.abandoned,
            .wait_duration_ns = abandoned.wait_duration_ns,
        };
    }

    fn append(self: *Queue, value: Entry, waiting: bool, now_ns: i128) void {
        if (waiting and self.wait_started_ns == null) self.wait_started_ns = now_ns;
        self.entries[self.count] = value;
        self.count += 1;
    }

    fn clearEntries(self: *Queue, allocator: std.mem.Allocator) Counts {
        var abandoned: Counts = .{};
        for (self.entries[0..self.count]) |*value| {
            abandoned.add(value.event.kind(), 1);
            value.event.deinit(allocator);
        }
        self.count = 0;
        self.paste_bytes = 0;
        return abandoned;
    }

    fn waitDuration(self: *const Queue, now_ns: i128) ?i128 {
        const started = self.wait_started_ns orelse return null;
        return if (now_ns >= started) now_ns - started else 0;
    }
};

test "motion coalesces only within semantic ordering barriers" {
    var queue: Queue = .{};
    defer _ = queue.clear(std.testing.allocator, 100);

    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 1, 0, 1, 2, false, 10).result);
    try std.testing.expectEqual(.coalesced, queue.pushMove(std.testing.allocator, 2, 0, 3, 4, false, 11).result);
    try std.testing.expectEqual(.queued, queue.pushKey(std.testing.allocator, 3, 0, 'x', true, false, 12).result);
    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 4, 0, 5, 6, false, 13).result);
    try std.testing.expectEqual(@as(usize, 3), queue.len());

    const first = queue.pop().?;
    switch (first.event) {
        .move => |position| {
            try std.testing.expectEqual(@as(u16, 3), position.x);
            try std.testing.expectEqual(@as(u16, 4), position.y);
        },
        else => return error.TestUnexpectedResult,
    }
}

test "waiting overflow abandons 32 events and starts a bounded blackout" {
    var queue: Queue = .{};
    defer _ = queue.clear(std.testing.allocator, 100 + max_age_ns);

    for (0..max_waiting_events) |index| {
        const result = queue.pushScroll(
            std.testing.allocator,
            index,
            0,
            @intCast(index),
            0,
            index % 2 != 0,
            true,
            10,
        );
        try std.testing.expectEqual(.queued, result.result);
    }
    const overflow = queue.pushKey(std.testing.allocator, 33, 0, 'z', true, true, 11);
    try std.testing.expectEqual(.overflow, overflow.result);
    try std.testing.expectEqual(@as(u64, max_waiting_events), overflow.abandoned.get(.scroll));
    try std.testing.expectEqual(@as(usize, 0), queue.len());
    try std.testing.expectEqual(.aborted, queue.pushMove(std.testing.allocator, 34, 0, 9, 9, true, 12).result);
    const expired = queue.expireWait(std.testing.allocator, 11 + max_age_ns).?;
    try std.testing.expectEqual(@as(u64, 0), expired.abandoned.get(.move));
    try std.testing.expectEqual(.queued, queue.pushMove(std.testing.allocator, 35, 0, 9, 9, true, 12 + max_age_ns).result);
}

test "popped paste is owned by the caller and clear frees only residents" {
    var queue: Queue = .{};
    try std.testing.expectEqual(.queued, queue.pushPaste(std.testing.allocator, 1, 0, "clipboard", false, 10).result);
    var popped = queue.pop().?;
    try std.testing.expectEqual(@as(usize, 0), queue.len());
    _ = queue.clear(std.testing.allocator, 11);
    popped.event.deinit(std.testing.allocator);
}
