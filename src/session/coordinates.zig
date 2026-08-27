const std = @import("std");

pub const Size = struct { width: f64, height: f64 };
pub const Point = struct { x: f64, y: f64 };
pub const Rect = struct { x: f64, y: f64, width: f64, height: f64 };
pub const RemotePoint = struct { x: u16, y: u16 };

pub fn aspectFit(container: Rect, remote: Size) ?Rect {
    if (container.width <= 0 or container.height <= 0 or remote.width <= 0 or remote.height <= 0) return null;
    const scale = @min(container.width / remote.width, container.height / remote.height);
    const width = remote.width * scale;
    const height = remote.height * scale;
    return .{
        .x = container.x + (container.width - width) / 2,
        .y = container.y + (container.height - height) / 2,
        .width = width,
        .height = height,
    };
}

pub fn mapPoint(point: Point, fitted: Rect, remote_width: u16, remote_height: u16, flip_y: bool) ?RemotePoint {
    if (remote_width == 0 or remote_height == 0 or fitted.width <= 0 or fitted.height <= 0) return null;
    if (point.x < fitted.x or point.y < fitted.y or point.x >= fitted.x + fitted.width or point.y >= fitted.y + fitted.height) return null;

    const normalized_x = (point.x - fitted.x) / fitted.width;
    var normalized_y = (point.y - fitted.y) / fitted.height;
    if (flip_y) normalized_y = 1 - normalized_y;
    const max_x = remote_width - 1;
    const max_y = remote_height - 1;
    return .{
        .x = @intFromFloat(@min(@as(f64, @floatFromInt(max_x)), @floor(normalized_x * @as(f64, @floatFromInt(remote_width))))),
        .y = @intFromFloat(@min(@as(f64, @floatFromInt(max_y)), @floor(normalized_y * @as(f64, @floatFromInt(remote_height))))),
    };
}

test "aspect fit rejects letterbox input" {
    const fitted = aspectFit(.{ .x = 0, .y = 0, .width = 1000, .height = 1000 }, .{ .width = 1920, .height = 1080 }).?;
    try std.testing.expectApproxEqAbs(@as(f64, 218.75), fitted.y, 0.001);
    try std.testing.expect(mapPoint(.{ .x = 500, .y = 100 }, fitted, 1920, 1080, false) == null);
    const center = mapPoint(.{ .x = 500, .y = 500 }, fitted, 1920, 1080, false).?;
    try std.testing.expectEqual(@as(u16, 960), center.x);
    try std.testing.expectEqual(@as(u16, 540), center.y);
}
