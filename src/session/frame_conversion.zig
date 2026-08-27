const std = @import("std");
const frame_mod = @import("frame.zig");

pub const ConversionError = error{
    InvalidFrame,
    InvalidRotation,
    InvalidOutput,
    OutputTooSmall,
};

/// Scales an I420 frame into caller-owned RGBA using nearest-neighbor sampling.
/// WebRTC's compatibility stream is treated as BT.601 limited range; alpha is
/// always opaque. Rotation is applied while sampling, so no full-size RGBA
/// intermediate is allocated.
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
    for (0..output_height) |output_y_usize| {
        const output_y: u32 = @intCast(output_y_usize);
        const oriented_y: u32 = @intCast((@as(u64, output_y) * display_height) / output_height);
        const row_offset = @as(usize, output_stride) * output_y_usize;
        for (0..output_width) |output_x_usize| {
            const output_x: u32 = @intCast(output_x_usize);
            const oriented_x: u32 = @intCast((@as(u64, output_x) * display_width) / output_width);
            const source = sourcePoint(frame, oriented_x, oriented_y);
            const y_index = @as(usize, source.y) * frame.strides[0] + source.x;
            const u_index = uv_offset + @as(usize, source.y / 2) * frame.strides[1] + source.x / 2;
            const v_index = v_offset + @as(usize, source.y / 2) * frame.strides[2] + source.x / 2;
            const rgba = yuvToRgba(frame.bytes[y_index], frame.bytes[u_index], frame.bytes[v_index]);
            const pixel_offset = row_offset + output_x_usize * 4;
            @memcpy(output[pixel_offset..][0..4], &rgba);
        }
    }
}

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
