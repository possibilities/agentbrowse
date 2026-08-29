const std = @import("std");
const cursor_packets = @import("../protocol/cursor_packets.zig");

pub const Snapshot = struct {
    generation: u64 = 0,
    image_generation: u64 = 0,
    position_generation: u64 = 0,
    image_available: bool = false,
    position_available: bool = false,
    width: u16 = 0,
    height: u16 = 0,
    hotspot_x: u16 = 0,
    hotspot_y: u16 = 0,
    position_x: u16 = 0,
    position_y: u16 = 0,
    image_length: u32 = 0,
};

pub const State = struct {
    mutex: std.atomic.Mutex = .unlocked,
    generation: u64 = 0,
    image_generation: u64 = 0,
    position_generation: u64 = 0,
    image: ?[]u8 = null,
    width: u16 = 0,
    height: u16 = 0,
    hotspot_x: u16 = 0,
    hotspot_y: u16 = 0,
    position_available: bool = false,
    position_x: u16 = 0,
    position_y: u16 = 0,

    pub fn updateImage(self: *State, allocator: std.mem.Allocator, value: cursor_packets.Image) !void {
        const copy = try allocator.dupe(u8, value.png);
        lock(&self.mutex);
        const old = self.image;
        self.image = copy;
        self.width = value.width;
        self.height = value.height;
        self.hotspot_x = value.hotspot_x;
        self.hotspot_y = value.hotspot_y;
        bump(&self.image_generation);
        bump(&self.generation);
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
    }

    pub fn updatePosition(self: *State, value: cursor_packets.Position) void {
        lock(&self.mutex);
        self.position_available = true;
        self.position_x = value.x;
        self.position_y = value.y;
        bump(&self.position_generation);
        bump(&self.generation);
        self.mutex.unlock();
    }

    pub fn clearPosition(self: *State) void {
        lock(&self.mutex);
        if (self.position_available) {
            self.position_available = false;
            bump(&self.position_generation);
            bump(&self.generation);
        }
        self.mutex.unlock();
    }

    pub fn reset(self: *State, allocator: std.mem.Allocator) void {
        lock(&self.mutex);
        const old = self.image;
        const had_image = old != null;
        const had_position = self.position_available;
        self.image = null;
        self.width = 0;
        self.height = 0;
        self.hotspot_x = 0;
        self.hotspot_y = 0;
        self.position_available = false;
        self.position_x = 0;
        self.position_y = 0;
        if (had_image) bump(&self.image_generation);
        if (had_position) bump(&self.position_generation);
        if (had_image or had_position) bump(&self.generation);
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
    }

    pub fn snapshot(self: *State) Snapshot {
        lock(&self.mutex);
        defer self.mutex.unlock();
        return .{
            .generation = self.generation,
            .image_generation = self.image_generation,
            .position_generation = self.position_generation,
            .image_available = self.image != null,
            .position_available = self.position_available,
            .width = self.width,
            .height = self.height,
            .hotspot_x = self.hotspot_x,
            .hotspot_y = self.hotspot_y,
            .position_x = self.position_x,
            .position_y = self.position_y,
            .image_length = if (self.image) |bytes| @intCast(bytes.len) else 0,
        };
    }

    pub fn copyImage(self: *State, image_generation: u64, output: []u8) usize {
        lock(&self.mutex);
        defer self.mutex.unlock();
        const image = self.image orelse return 0;
        if (image_generation != self.image_generation or output.len < image.len) return 0;
        @memcpy(output[0..image.len], image);
        return image.len;
    }

    pub fn deinit(self: *State, allocator: std.mem.Allocator) void {
        lock(&self.mutex);
        const old = self.image;
        self.image = null;
        self.position_available = false;
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
    }
};

fn bump(value: *u64) void {
    value.* +%= 1;
    if (value.* == 0) value.* = 1;
}

fn lock(mutex: *std.atomic.Mutex) void {
    while (!mutex.tryLock()) std.atomic.spinLoopHint();
}

test "cursor observation owns images and invalidates remote positions" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);
    const png = [_]u8{ 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a };
    try state.updateImage(std.testing.allocator, .{
        .width = 24,
        .height = 24,
        .hotspot_x = 2,
        .hotspot_y = 3,
        .png = &png,
    });
    state.updatePosition(.{ .x = 100, .y = 200 });

    const current = state.snapshot();
    try std.testing.expect(current.image_available);
    try std.testing.expect(current.position_available);
    try std.testing.expectEqual(@as(u32, png.len), current.image_length);
    var copied: [png.len]u8 = undefined;
    try std.testing.expectEqual(png.len, state.copyImage(current.image_generation, &copied));
    try std.testing.expectEqualSlices(u8, &png, &copied);

    state.clearPosition();
    const cleared = state.snapshot();
    try std.testing.expect(!cleared.position_available);
    try std.testing.expect(cleared.position_generation > current.position_generation);
}
