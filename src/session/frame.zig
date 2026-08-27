const std = @import("std");

pub const Format = enum { i420, nv12, bgra8, rgba8 };

pub const Frame = struct {
    allocator: std.mem.Allocator,
    refs: std.atomic.Value(u32) = .init(1),
    width: u32,
    height: u32,
    format: Format,
    timestamp_us: i64,
    strides: [3]u32,
    plane_lengths: [3]usize,
    bytes: []u8,

    pub fn create(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        format: Format,
        timestamp_us: i64,
        strides: [3]u32,
        plane_lengths: [3]usize,
        source: []const u8,
    ) !*Frame {
        const self = try allocator.create(Frame);
        errdefer allocator.destroy(self);
        const bytes = try allocator.dupe(u8, source);
        self.* = .{
            .allocator = allocator,
            .width = width,
            .height = height,
            .format = format,
            .timestamp_us = timestamp_us,
            .strides = strides,
            .plane_lengths = plane_lengths,
            .bytes = bytes,
        };
        return self;
    }

    pub fn createI420(
        allocator: std.mem.Allocator,
        width: u32,
        height: u32,
        timestamp_us: i64,
        plane_y: []const u8,
        stride_y: u32,
        plane_u: []const u8,
        stride_u: u32,
        plane_v: []const u8,
        stride_v: u32,
    ) !*Frame {
        const lengths = [3]usize{ plane_y.len, plane_u.len, plane_v.len };
        const total = try std.math.add(usize, plane_y.len, try std.math.add(usize, plane_u.len, plane_v.len));
        const self = try allocator.create(Frame);
        errdefer allocator.destroy(self);
        const bytes = try allocator.alloc(u8, total);
        @memcpy(bytes[0..plane_y.len], plane_y);
        @memcpy(bytes[plane_y.len..][0..plane_u.len], plane_u);
        @memcpy(bytes[plane_y.len + plane_u.len ..], plane_v);
        self.* = .{
            .allocator = allocator,
            .width = width,
            .height = height,
            .format = .i420,
            .timestamp_us = timestamp_us,
            .strides = .{ stride_y, stride_u, stride_v },
            .plane_lengths = lengths,
            .bytes = bytes,
        };
        return self;
    }

    pub fn retain(self: *Frame) void {
        _ = self.refs.fetchAdd(1, .monotonic);
    }

    pub fn release(self: *Frame) void {
        if (self.refs.fetchSub(1, .acq_rel) == 1) {
            const allocator = self.allocator;
            allocator.free(self.bytes);
            allocator.destroy(self);
        }
    }
};

pub const Lease = struct {
    frame: *Frame,

    pub fn clone(self: Lease) Lease {
        self.frame.retain();
        return .{ .frame = self.frame };
    }

    pub fn release(self: *Lease) void {
        self.frame.release();
        self.* = undefined;
    }
};

pub fn checksum(frame: *const Frame) u64 {
    return std.hash.Wyhash.hash(0, frame.bytes);
}

test "frame checksum follows immutable bytes" {
    const first = try Frame.create(std.testing.allocator, 1, 1, .i420, 1, .{ 1, 1, 1 }, .{ 1, 0, 0 }, &.{1});
    defer first.release();
    const second = try Frame.create(std.testing.allocator, 1, 1, .i420, 2, .{ 1, 1, 1 }, .{ 1, 0, 0 }, &.{2});
    defer second.release();
    try std.testing.expect(checksum(first) != checksum(second));
}
