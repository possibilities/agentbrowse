const std = @import("std");
const frame_mod = @import("frame.zig");

pub const ConversionError = error{
    InvalidFrame,
    InvalidRotation,
    InvalidOutput,
    OutputTooSmall,
};

/// Scales an I420 frame into caller-owned RGBA. Exact-size conversions use a
/// direct sample; resized conversions use center-aligned bilinear sampling on
/// the luma and both chroma planes. WebRTC's compatibility stream is treated
/// as BT.601 limited range; alpha is always opaque. Rotation is applied while
/// sampling, so no full-size RGBA intermediate is allocated.
pub fn i420ToRgba(
    frame: *const frame_mod.Frame,
    output_width: u32,
    output_height: u32,
    output: []u8,
    output_stride: u32,
) ConversionError!void {
    if (frame.format != .i420 or frame.width == 0 or frame.height == 0) return error.InvalidFrame;
    if (frame.rotation != 0 and frame.rotation != 90 and frame.rotation != 180 and frame.rotation != 270) {
        return error.InvalidRotation;
    }
    if (output_width == 0 or output_height == 0) return error.InvalidOutput;
    const row_bytes = std.math.mul(u32, output_width, 4) catch return error.InvalidOutput;
    if (output_stride < row_bytes) return error.InvalidOutput;
    const required = std.math.mul(usize, output_stride, output_height) catch return error.InvalidOutput;
    if (output.len < required) return error.OutputTooSmall;

    const chroma_width = (frame.width + 1) / 2;
    const chroma_height = (frame.height + 1) / 2;
    if (frame.strides[0] < frame.width or frame.strides[1] < chroma_width or frame.strides[2] < chroma_width) {
        return error.InvalidFrame;
    }
    const expected_y = std.math.mul(usize, frame.strides[0], frame.height) catch return error.InvalidFrame;
    const expected_u = std.math.mul(usize, frame.strides[1], chroma_height) catch return error.InvalidFrame;
    const expected_v = std.math.mul(usize, frame.strides[2], chroma_height) catch return error.InvalidFrame;
    if (frame.plane_lengths[0] < expected_y or frame.plane_lengths[1] < expected_u or frame.plane_lengths[2] < expected_v) {
        return error.InvalidFrame;
    }
    const uv_offset = frame.plane_lengths[0];
    const v_offset = std.math.add(usize, uv_offset, frame.plane_lengths[1]) catch return error.InvalidFrame;
    if (v_offset > frame.bytes.len or frame.plane_lengths[2] > frame.bytes.len - v_offset) return error.InvalidFrame;

    const display_width = frame.displayWidth();
    const display_height = frame.displayHeight();
    const y_plane = Plane{
        .bytes = frame.bytes[0..uv_offset],
        .stride = frame.strides[0],
        .width = frame.width,
        .height = frame.height,
    };
    const u_plane = Plane{
        .bytes = frame.bytes[uv_offset..v_offset],
        .stride = frame.strides[1],
        .width = chroma_width,
        .height = chroma_height,
    };
    const v_plane = Plane{
        .bytes = frame.bytes[v_offset..][0..frame.plane_lengths[2]],
        .stride = frame.strides[2],
        .width = chroma_width,
        .height = chroma_height,
    };
    const exact_size = output_width == display_width and output_height == display_height;
    var y_luma = AxisCursor.init(output_height, orientedHeight(y_plane, frame.rotation));
    var y_chroma = AxisCursor.init(output_height, orientedHeight(u_plane, frame.rotation));
    for (0..output_height) |output_y_usize| {
        const output_y: u32 = @intCast(output_y_usize);
        const row_offset = @as(usize, output_stride) * output_y_usize;
        const luma_y = if (exact_size) undefined else y_luma.next();
        const chroma_y = if (exact_size) undefined else y_chroma.next();
        var x_luma = AxisCursor.init(output_width, orientedWidth(y_plane, frame.rotation));
        var x_chroma = AxisCursor.init(output_width, orientedWidth(u_plane, frame.rotation));
        for (0..output_width) |output_x_usize| {
            const output_x: u32 = @intCast(output_x_usize);
            const rgba = if (exact_size) blk: {
                const source = sourcePoint(frame, output_x, output_y);
                const y_index = @as(usize, source.y) * frame.strides[0] + source.x;
                const u_index = @as(usize, source.y / 2) * frame.strides[1] + source.x / 2;
                const v_index = @as(usize, source.y / 2) * frame.strides[2] + source.x / 2;
                break :blk yuvToRgba(y_plane.bytes[y_index], u_plane.bytes[u_index], v_plane.bytes[v_index]);
            } else yuvToRgba(
                sampleBilinear(y_plane, frame.rotation, x_luma.next(), luma_y),
                sampleBilinear(u_plane, frame.rotation, x_chroma.next(), chroma_y),
                sampleBilinear(v_plane, frame.rotation, x_chroma.current(), chroma_y),
            );
            const pixel_offset = row_offset + output_x_usize * 4;
            @memcpy(output[pixel_offset..][0..4], &rgba);
        }
    }
}

const Plane = struct {
    bytes: []const u8,
    stride: u32,
    width: u32,
    height: u32,
};

const AxisSample = struct {
    lower: u32,
    upper: u32,
    fraction: u32,
};

const AxisCursor = struct {
    position_q32: i128,
    step_q32: i128,
    maximum_q32: i128,
    latest: AxisSample = .{ .lower = 0, .upper = 0, .fraction = 0 },

    fn init(output_size: u32, input_size: u32) AxisCursor {
        if (input_size <= 1) return .{ .position_q32 = 0, .step_q32 = 0, .maximum_q32 = 0 };
        const step_q32 = @divTrunc(@as(i128, input_size) << 32, @as(i128, output_size));
        return .{
            .position_q32 = @divTrunc(step_q32, 2) - (1 << 31),
            .step_q32 = step_q32,
            .maximum_q32 = @as(i128, input_size - 1) << 32,
        };
    }

    fn next(self: *AxisCursor) AxisSample {
        const clamped_q32 = @max(0, @min(self.position_q32, self.maximum_q32));
        const lower: u32 = @intCast(clamped_q32 >> 32);
        self.latest = .{
            .lower = lower,
            .upper = @min(lower + 1, @as(u32, @intCast(self.maximum_q32 >> 32))),
            .fraction = @intCast((clamped_q32 >> 16) & 0xffff),
        };
        self.position_q32 += self.step_q32;
        return self.latest;
    }

    fn current(self: *const AxisCursor) AxisSample {
        return self.latest;
    }
};

const SourcePoint = struct { x: u32, y: u32 };

fn sourcePoint(frame: *const frame_mod.Frame, x: u32, y: u32) SourcePoint {
    return switch (frame.rotation) {
        0 => .{ .x = x, .y = y },
        90 => .{ .x = y, .y = frame.height - 1 - x },
        180 => .{ .x = frame.width - 1 - x, .y = frame.height - 1 - y },
        270 => .{ .x = frame.width - 1 - y, .y = x },
        else => unreachable,
    };
}

fn orientedWidth(plane: Plane, rotation: u16) u32 {
    return if (rotation == 90 or rotation == 270) plane.height else plane.width;
}

fn orientedHeight(plane: Plane, rotation: u16) u32 {
    return if (rotation == 90 or rotation == 270) plane.width else plane.height;
}

fn sampleBilinear(plane: Plane, rotation: u16, x: AxisSample, y: AxisSample) u8 {
    const top_left = sourcePointForPlane(plane, rotation, x.lower, y.lower);
    const top_right = sourcePointForPlane(plane, rotation, x.upper, y.lower);
    const bottom_left = sourcePointForPlane(plane, rotation, x.lower, y.upper);
    const bottom_right = sourcePointForPlane(plane, rotation, x.upper, y.upper);
    return bilinear(
        plane.bytes[@as(usize, top_left.y) * plane.stride + top_left.x],
        plane.bytes[@as(usize, top_right.y) * plane.stride + top_right.x],
        plane.bytes[@as(usize, bottom_left.y) * plane.stride + bottom_left.x],
        plane.bytes[@as(usize, bottom_right.y) * plane.stride + bottom_right.x],
        x.fraction,
        y.fraction,
    );
}

fn sourcePointForPlane(plane: Plane, rotation: u16, x: u32, y: u32) SourcePoint {
    return switch (rotation) {
        0 => .{ .x = x, .y = y },
        90 => .{ .x = y, .y = plane.height - 1 - x },
        180 => .{ .x = plane.width - 1 - x, .y = plane.height - 1 - y },
        270 => .{ .x = plane.width - 1 - y, .y = x },
        else => unreachable,
    };
}

fn bilinear(top_left: u8, top_right: u8, bottom_left: u8, bottom_right: u8, x: u32, y: u32) u8 {
    const one: u64 = 1 << 16;
    const inverse_x = one - x;
    const inverse_y = one - y;
    const top = @as(u64, top_left) * inverse_x + @as(u64, top_right) * x;
    const bottom = @as(u64, bottom_left) * inverse_x + @as(u64, bottom_right) * x;
    const value = (top * inverse_y + bottom * y + (1 << 31)) >> 32;
    return @intCast(value);
}

fn yuvToRgba(y_value: u8, u_value: u8, v_value: u8) [4]u8 {
    const y: i32 = @max(0, @as(i32, y_value) - 16);
    const u: i32 = @as(i32, u_value) - 128;
    const v: i32 = @as(i32, v_value) - 128;
    return .{
        clip((298 * y + 409 * v + 128) >> 8),
        clip((298 * y - 100 * u - 208 * v + 128) >> 8),
        clip((298 * y + 516 * u + 128) >> 8),
        255,
    };
}

fn clip(value: i32) u8 {
    return @intCast(@max(0, @min(255, value)));
}

test "I420 limited-range black and white convert to opaque RGBA" {
    const frame = try frame_mod.Frame.createI420(
        std.testing.allocator,
        2,
        1,
        0,
        1,
        &.{ 16, 235 },
        2,
        &.{128},
        1,
        &.{128},
        1,
    );
    defer frame.release();
    var output: [8]u8 = undefined;
    try i420ToRgba(frame, 2, 1, &output, 8);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 255, 255, 255, 255, 255 }, &output);
}

test "conversion applies clockwise rotation while scaling" {
    const frame = try frame_mod.Frame.createI420(
        std.testing.allocator,
        2,
        1,
        90,
        1,
        &.{ 16, 235 },
        2,
        &.{128},
        1,
        &.{128},
        1,
    );
    defer frame.release();
    var output: [8]u8 = undefined;
    try i420ToRgba(frame, 1, 2, &output, 4);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 255, 255, 255, 255, 255 }, &output);
}

test "resized conversion linearly blends neighboring luma samples" {
    const frame = try frame_mod.Frame.createI420(
        std.testing.allocator,
        2,
        1,
        0,
        1,
        &.{ 16, 235 },
        2,
        &.{128},
        1,
        &.{128},
        1,
    );
    defer frame.release();
    var output: [4]u8 = undefined;
    try i420ToRgba(frame, 1, 1, &output, 4);
    try std.testing.expectEqualSlices(u8, &.{ 128, 128, 128, 255 }, &output);
}

test "resized conversion linearly blends subsampled chroma" {
    const frame = try frame_mod.Frame.createI420(
        std.testing.allocator,
        4,
        2,
        0,
        1,
        &.{ 128, 128, 128, 128, 128, 128, 128, 128 },
        4,
        &.{ 16, 240 },
        2,
        &.{ 128, 128 },
        2,
    );
    defer frame.release();
    var output: [4]u8 = undefined;
    try i420ToRgba(frame, 1, 1, &output, 4);
    try std.testing.expectEqualSlices(u8, &.{ 130, 130, 130, 255 }, &output);
}

test "filtered scaling preserves clockwise rotation" {
    const frame = try frame_mod.Frame.createI420(
        std.testing.allocator,
        4,
        2,
        90,
        1,
        &.{ 16, 16, 235, 235, 16, 16, 235, 235 },
        4,
        &.{ 128, 128 },
        2,
        &.{ 128, 128 },
        2,
    );
    defer frame.release();
    var output: [8]u8 = undefined;
    try i420ToRgba(frame, 1, 2, &output, 4);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 255, 255, 255, 255, 255 }, &output);
}

test "filtered scaling keeps odd I420 planes in bounds for every rotation" {
    const y = [_]u8{128} ** 15;
    const u = [_]u8{128} ** 6;
    const v = [_]u8{128} ** 6;
    for ([_]u16{ 0, 90, 180, 270 }) |rotation| {
        const frame = try frame_mod.Frame.createI420(
            std.testing.allocator,
            3,
            5,
            rotation,
            1,
            &y,
            3,
            &u,
            2,
            &v,
            2,
        );
        defer frame.release();
        var output: [7 * 9 * 4]u8 = undefined;
        try i420ToRgba(frame, 7, 9, &output, 7 * 4);
        for (0..7 * 9) |pixel| {
            try std.testing.expectEqual(@as(u8, 255), output[pixel * 4 + 3]);
        }
    }
}
