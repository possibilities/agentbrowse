const std = @import("std");
const frame_mod = @import("frame.zig");

pub const Frame = frame_mod.Frame;
pub const max_output_dimension: u32 = 8192;

const parallel_worker_count = 4;
const parallel_min_pixels: u64 = 256 * 1024;
const max_cached_columns = max_output_dimension;

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
    return i420ToRgbaWithMode(frame, output_width, output_height, output, output_stride, .automatic);
}

const ConversionMode = enum { automatic, serial, serial_uncached, parallel };

fn i420ToRgbaWithMode(
    frame: *const frame_mod.Frame,
    output_width: u32,
    output_height: u32,
    output: []u8,
    output_stride: u32,
    mode: ConversionMode,
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
    const conversion = Conversion{
        .frame = frame,
        .y_plane = y_plane,
        .u_plane = u_plane,
        .v_plane = v_plane,
        .output_width = output_width,
        .output_height = output_height,
        .output = output,
        .output_stride = output_stride,
        .exact_size = output_width == display_width and output_height == display_height,
    };

    const columns: ?ColumnSamples = if (!conversion.exact_size and output_width <= max_cached_columns) blk: {
        const width: usize = @intCast(output_width);
        fillAxisSamples(
            luma_columns_storage[0..width],
            output_width,
            orientedWidth(y_plane, frame.rotation),
        );
        fillAxisSamples(
            chroma_columns_storage[0..width],
            output_width,
            orientedWidth(u_plane, frame.rotation),
        );
        break :blk .{
            .luma = luma_columns_storage[0..width],
            .chroma = chroma_columns_storage[0..width],
        };
    } else null;

    const pixels = @as(u64, output_width) * output_height;
    const selected_columns = if (mode == .serial_uncached) null else columns;
    const use_parallel = switch (mode) {
        .automatic => pixels >= parallel_min_pixels and output_height >= parallel_worker_count,
        .serial, .serial_uncached => false,
        .parallel => output_height >= parallel_worker_count,
    };
    if (use_parallel and convertRowsParallel(conversion, selected_columns)) return;
    convertRows(conversion, selected_columns, 0, output_height);
}

const Conversion = struct {
    frame: *const frame_mod.Frame,
    y_plane: Plane,
    u_plane: Plane,
    v_plane: Plane,
    output_width: u32,
    output_height: u32,
    output: []u8,
    output_stride: u32,
    exact_size: bool,
};

const ColumnSamples = struct {
    luma: []const AxisSample,
    chroma: []const AxisSample,
};

const RowWork = struct {
    conversion: Conversion,
    columns: ?ColumnSamples,
    start_row: u32,
    end_row: u32,
};

fn convertRowsParallel(conversion: Conversion, columns: ?ColumnSamples) bool {
    const rows_per_worker = conversion.output_height / parallel_worker_count;
    var work: [parallel_worker_count - 1]RowWork = undefined;
    var threads: [parallel_worker_count - 1]std.Thread = undefined;
    var spawned: usize = 0;

    for (0..parallel_worker_count - 1) |worker_index| {
        const start_row: u32 = @intCast(worker_index * rows_per_worker);
        work[worker_index] = .{
            .conversion = conversion,
            .columns = columns,
            .start_row = start_row,
            .end_row = start_row + rows_per_worker,
        };
        threads[worker_index] = std.Thread.spawn(
            .{ .stack_size = 128 * 1024 },
            convertRowWork,
            .{&work[worker_index]},
        ) catch {
            for (threads[0..spawned]) |thread| thread.join();
            return false;
        };
        spawned += 1;
    }

    convertRows(
        conversion,
        columns,
        rows_per_worker * (parallel_worker_count - 1),
        conversion.output_height,
    );
    for (threads[0..spawned]) |thread| thread.join();
    return true;
}

fn convertRowWork(work: *const RowWork) void {
    convertRows(work.conversion, work.columns, work.start_row, work.end_row);
}

fn convertRows(
    conversion: Conversion,
    columns: ?ColumnSamples,
    start_row: u32,
    end_row: u32,
) void {
    if (conversion.exact_size) {
        convertExactRows(conversion, start_row, end_row);
    } else if (columns) |cached| {
        convertFilteredRows(conversion, cached, start_row, end_row);
    } else {
        convertFilteredRowsWithoutColumnCache(conversion, start_row, end_row);
    }
}

fn convertExactRows(conversion: Conversion, start_row: u32, end_row: u32) void {
    for (start_row..end_row) |output_y_usize| {
        const output_y: u32 = @intCast(output_y_usize);
        const row_offset = @as(usize, conversion.output_stride) * output_y_usize;
        for (0..conversion.output_width) |output_x_usize| {
            const output_x: u32 = @intCast(output_x_usize);
            const source = sourcePoint(conversion.frame, output_x, output_y);
            const y_index = @as(usize, source.y) * conversion.frame.strides[0] + source.x;
            const u_index = @as(usize, source.y / 2) * conversion.frame.strides[1] + source.x / 2;
            const v_index = @as(usize, source.y / 2) * conversion.frame.strides[2] + source.x / 2;
            const rgba = yuvToRgba(
                conversion.y_plane.bytes[y_index],
                conversion.u_plane.bytes[u_index],
                conversion.v_plane.bytes[v_index],
            );
            const pixel_offset = row_offset + output_x_usize * 4;
            @memcpy(conversion.output[pixel_offset..][0..4], &rgba);
        }
    }
}

fn convertFilteredRows(
    conversion: Conversion,
    columns: ColumnSamples,
    start_row: u32,
    end_row: u32,
) void {
    var y_luma = AxisCursor.initAt(
        conversion.output_height,
        orientedHeight(conversion.y_plane, conversion.frame.rotation),
        start_row,
    );
    var y_chroma = AxisCursor.initAt(
        conversion.output_height,
        orientedHeight(conversion.u_plane, conversion.frame.rotation),
        start_row,
    );
    for (start_row..end_row) |output_y_usize| {
        const row_offset = @as(usize, conversion.output_stride) * output_y_usize;
        const luma_y = y_luma.next();
        const chroma_y = y_chroma.next();
        for (0..conversion.output_width) |output_x_usize| {
            const rgba = yuvToRgba(
                sampleBilinear(
                    conversion.y_plane,
                    conversion.frame.rotation,
                    columns.luma[output_x_usize],
                    luma_y,
                ),
                sampleBilinear(
                    conversion.u_plane,
                    conversion.frame.rotation,
                    columns.chroma[output_x_usize],
                    chroma_y,
                ),
                sampleBilinear(
                    conversion.v_plane,
                    conversion.frame.rotation,
                    columns.chroma[output_x_usize],
                    chroma_y,
                ),
            );
            const pixel_offset = row_offset + output_x_usize * 4;
            @memcpy(conversion.output[pixel_offset..][0..4], &rgba);
        }
    }
}

fn convertFilteredRowsWithoutColumnCache(
    conversion: Conversion,
    start_row: u32,
    end_row: u32,
) void {
    var y_luma = AxisCursor.initAt(
        conversion.output_height,
        orientedHeight(conversion.y_plane, conversion.frame.rotation),
        start_row,
    );
    var y_chroma = AxisCursor.initAt(
        conversion.output_height,
        orientedHeight(conversion.u_plane, conversion.frame.rotation),
        start_row,
    );
    for (start_row..end_row) |output_y_usize| {
        const row_offset = @as(usize, conversion.output_stride) * output_y_usize;
        const luma_y = y_luma.next();
        const chroma_y = y_chroma.next();
        var x_luma = AxisCursor.init(conversion.output_width, orientedWidth(conversion.y_plane, conversion.frame.rotation));
        var x_chroma = AxisCursor.init(conversion.output_width, orientedWidth(conversion.u_plane, conversion.frame.rotation));
        for (0..conversion.output_width) |output_x_usize| {
            const rgba = yuvToRgba(
                sampleBilinear(conversion.y_plane, conversion.frame.rotation, x_luma.next(), luma_y),
                sampleBilinear(conversion.u_plane, conversion.frame.rotation, x_chroma.next(), chroma_y),
                sampleBilinear(conversion.v_plane, conversion.frame.rotation, x_chroma.current(), chroma_y),
            );
            const pixel_offset = row_offset + output_x_usize * 4;
            @memcpy(conversion.output[pixel_offset..][0..4], &rgba);
        }
    }
}

fn fillAxisSamples(samples: []AxisSample, output_size: u32, input_size: u32) void {
    var cursor = AxisCursor.init(output_size, input_size);
    for (samples) |*sample| sample.* = cursor.next();
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

// Conversion callers may be language-runtime worker threads whose stack size
// is not configurable. Keep the two ~192 KiB column caches off every caller's
// stack; row workers only borrow these slices until their mandatory join.
threadlocal var luma_columns_storage: [max_cached_columns]AxisSample = undefined;
threadlocal var chroma_columns_storage: [max_cached_columns]AxisSample = undefined;

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

    fn initAt(output_size: u32, input_size: u32, output_index: u32) AxisCursor {
        var cursor = init(output_size, input_size);
        cursor.position_q32 += cursor.step_q32 * @as(i128, output_index);
        return cursor;
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

test "row-parallel conversion is bit-exact for every rotation" {
    const frame_width: u32 = 640;
    const frame_height: u32 = 360;
    const chroma_width = (frame_width + 1) / 2;
    const chroma_height = (frame_height + 1) / 2;
    const allocator = std.testing.allocator;

    const y = try allocator.alloc(u8, @as(usize, frame_width) * frame_height);
    defer allocator.free(y);
    const u = try allocator.alloc(u8, @as(usize, chroma_width) * chroma_height);
    defer allocator.free(u);
    const v = try allocator.alloc(u8, @as(usize, chroma_width) * chroma_height);
    defer allocator.free(v);
    var prng = std.Random.DefaultPrng.init(0x9b58_6d27_41e3_0acf);
    const random = prng.random();
    random.bytes(y);
    random.bytes(u);
    random.bytes(v);

    for ([_]u16{ 0, 90, 180, 270 }) |rotation| {
        const frame = try frame_mod.Frame.createI420(
            allocator,
            frame_width,
            frame_height,
            rotation,
            1,
            y,
            frame_width,
            u,
            chroma_width,
            v,
            chroma_width,
        );
        defer frame.release();

        // The odd output height leaves the remainder rows with worker four.
        try expectSerialParallelEqual(frame, 517, 291);
        try expectSerialParallelEqual(frame, frame.displayWidth(), frame.displayHeight());
    }
}

fn expectSerialParallelEqual(frame: *const frame_mod.Frame, width: u32, height: u32) !void {
    const stride = width * 4 + 16;
    const byte_count = @as(usize, stride) * height;
    const uncached = try std.testing.allocator.alloc(u8, byte_count);
    defer std.testing.allocator.free(uncached);
    const serial = try std.testing.allocator.alloc(u8, byte_count);
    defer std.testing.allocator.free(serial);
    const parallel = try std.testing.allocator.alloc(u8, byte_count);
    defer std.testing.allocator.free(parallel);
    @memset(uncached, 0xa5);
    @memset(serial, 0xa5);
    @memset(parallel, 0xa5);

    try i420ToRgbaWithMode(frame, width, height, uncached, stride, .serial_uncached);
    try i420ToRgbaWithMode(frame, width, height, serial, stride, .serial);
    try i420ToRgbaWithMode(frame, width, height, parallel, stride, .parallel);
    try std.testing.expectEqualSlices(u8, uncached, serial);
    try std.testing.expectEqualSlices(u8, serial, parallel);
}
