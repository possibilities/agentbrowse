const std = @import("std");
const frame_mod = @import("frame.zig");

pub const Stats = struct {
    published: u64 = 0,
    replaced: u64 = 0,
    acquired: u64 = 0,
};

pub const Queue = struct {
    mutex: std.atomic.Mutex = .unlocked,
    latest: ?*frame_mod.Frame = null,
    stats: Stats = .{},

    pub fn publish(self: *Queue, next: *frame_mod.Frame) void {
        lock(&self.mutex);
        const replaced = self.latest;
        self.latest = next;
        self.stats.published += 1;
        if (replaced != null) self.stats.replaced += 1;
        self.mutex.unlock();
        if (replaced) |old| old.release();
    }

    pub fn acquireLatest(self: *Queue) ?frame_mod.Lease {
        lock(&self.mutex);
        defer self.mutex.unlock();
        const latest = self.latest orelse return null;
        latest.retain();
        self.stats.acquired += 1;
        return .{ .frame = latest };
    }

    pub fn snapshotStats(self: *Queue) Stats {
        lock(&self.mutex);
        defer self.mutex.unlock();
        return self.stats;
    }

    pub fn clear(self: *Queue) void {
        lock(&self.mutex);
        const latest = self.latest;
        self.latest = null;
        self.mutex.unlock();
        if (latest) |old| old.release();
    }
};

fn lock(mutex: *std.atomic.Mutex) void {
    while (!mutex.tryLock()) std.atomic.spinLoopHint();
}

test "latest frame wins and leases outlive replacement" {
    var queue: Queue = .{};
    defer queue.clear();
    const first = try frame_mod.Frame.create(std.testing.allocator, 1, 1, .i420, 1, .{ 1, 1, 1 }, .{ 1, 0, 0 }, &.{1});
    queue.publish(first);
    var lease = queue.acquireLatest().?;
    defer lease.release();

    const second = try frame_mod.Frame.create(std.testing.allocator, 1, 1, .i420, 2, .{ 1, 1, 1 }, .{ 1, 0, 0 }, &.{2});
    queue.publish(second);
    try std.testing.expectEqual(@as(i64, 1), lease.frame.timestamp_us);
    const stats = queue.snapshotStats();
    try std.testing.expectEqual(@as(u64, 2), stats.published);
    try std.testing.expectEqual(@as(u64, 1), stats.replaced);
}
