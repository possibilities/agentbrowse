const std = @import("std");
const input_event = @import("input_event.zig");

pub const Stage = enum {
    attempted,
    queued,
    sent,
    coalesced,
    control_dropped,
    send_failed,
    duplicate_suppressed,
};

pub const KindMetrics = struct {
    attempted: u64,
    queued: u64,
    sent: u64,
    coalesced: u64,
    control_dropped: u64,
    send_failed: u64,
    duplicate_suppressed: u64,
};

pub const Snapshot = struct {
    kinds: [input_event.kind_count]KindMetrics,
    queue_depth: u32,
    queue_capacity: u32,
    epoch: u64,
    control_wait_ns: u64,
    control_wait_count: u64,
};

const Atomic = std.atomic.Value(u64);

const AtomicKindMetrics = struct {
    attempted: Atomic = .init(0),
    queued: Atomic = .init(0),
    sent: Atomic = .init(0),
    coalesced: Atomic = .init(0),
    control_dropped: Atomic = .init(0),
    send_failed: Atomic = .init(0),
    duplicate_suppressed: Atomic = .init(0),

    fn note(self: *AtomicKindMetrics, stage: Stage, amount: u64) void {
        if (amount == 0) return;
        const counter = switch (stage) {
            .attempted => &self.attempted,
            .queued => &self.queued,
            .sent => &self.sent,
            .coalesced => &self.coalesced,
            .control_dropped => &self.control_dropped,
            .send_failed => &self.send_failed,
            .duplicate_suppressed => &self.duplicate_suppressed,
        };
        _ = counter.fetchAdd(amount, .monotonic);
    }

    fn snapshot(self: *const AtomicKindMetrics) KindMetrics {
        return .{
            .attempted = self.attempted.load(.acquire),
            .queued = self.queued.load(.acquire),
            .sent = self.sent.load(.acquire),
            .coalesced = self.coalesced.load(.acquire),
            .control_dropped = self.control_dropped.load(.acquire),
            .send_failed = self.send_failed.load(.acquire),
            .duplicate_suppressed = self.duplicate_suppressed.load(.acquire),
        };
    }
};

pub const Counters = struct {
    kinds: [input_event.kind_count]AtomicKindMetrics = [_]AtomicKindMetrics{.{}} ** input_event.kind_count,
    control_wait_ns: Atomic = .init(0),
    control_wait_count: Atomic = .init(0),

    pub fn note(self: *Counters, kind: input_event.Kind, stage: Stage) void {
        self.noteMany(kind, stage, 1);
    }

    pub fn noteMany(self: *Counters, kind: input_event.Kind, stage: Stage, amount: u64) void {
        self.kinds[@intFromEnum(kind)].note(stage, amount);
    }

    pub fn noteCounts(self: *Counters, counts: input_event.Counts, stage: Stage) void {
        for (counts.values, 0..) |amount, index| {
            self.kinds[index].note(stage, amount);
        }
    }

    pub fn noteControlWait(self: *Counters, duration_ns: i128) void {
        const bounded: u64 = if (duration_ns <= 0)
            0
        else
            @intCast(@min(duration_ns, std.math.maxInt(u64)));
        _ = self.control_wait_ns.fetchAdd(bounded, .monotonic);
        _ = self.control_wait_count.fetchAdd(1, .monotonic);
    }

    pub fn snapshot(self: *const Counters, queue_depth: u32, queue_capacity: u32, epoch: u64) Snapshot {
        var kinds: [input_event.kind_count]KindMetrics = undefined;
        for (&kinds, &self.kinds) |*target, *source| target.* = source.snapshot();
        return .{
            .kinds = kinds,
            .queue_depth = queue_depth,
            .queue_capacity = queue_capacity,
            .epoch = epoch,
            .control_wait_ns = self.control_wait_ns.load(.acquire),
            .control_wait_count = self.control_wait_count.load(.acquire),
        };
    }
};

test "per-kind counters snapshot monotonically" {
    var counters: Counters = .{};
    counters.note(.key, .attempted);
    counters.noteMany(.key, .sent, 2);
    counters.noteControlWait(25);
    const value = counters.snapshot(3, 256, 4);
    try std.testing.expectEqual(@as(u64, 1), value.kinds[@intFromEnum(input_event.Kind.key)].attempted);
    try std.testing.expectEqual(@as(u64, 2), value.kinds[@intFromEnum(input_event.Kind.key)].sent);
    try std.testing.expectEqual(@as(u64, 25), value.control_wait_ns);
    try std.testing.expectEqual(@as(u64, 1), value.control_wait_count);
}
