const std = @import("std");
const frame_conversion = @import("frame_conversion");

const iterations = 20;
const sizes = [_][2]u32{
    .{ 1920, 1080 },
    .{ 1728, 972 },
    .{ 1280, 720 },
    .{ 960, 540 },
};

pub fn main(init: std.process.Init) !void {
    const allocator = std.heap.page_allocator;
    const y = try allocator.alloc(u8, 1920 * 1080);
    defer allocator.free(y);
    const u = try allocator.alloc(u8, 960 * 540);
    defer allocator.free(u);
    const v = try allocator.alloc(u8, 960 * 540);
    defer allocator.free(v);
    var prng = std.Random.DefaultPrng.init(0x41bc_8d27_9ea0_53f6);
    const random = prng.random();
    random.bytes(y);
    random.bytes(u);
    random.bytes(v);

    const frame = try frame_conversion.Frame.createI420(
        allocator,
        1920,
        1080,
        0,
        1,
        y,
        1920,
        u,
        960,
        v,
        960,
    );
    defer frame.release();

    std.debug.print(
        "I420 to RGBA, random 1920x1080 source, warm output, {d} iterations, nearest-rank p95\n",
        .{iterations},
    );
    for (sizes) |size| {
        const output = try allocator.alloc(u8, @as(usize, size[0]) * size[1] * 4);
        defer allocator.free(output);
        try frame_conversion.i420ToRgba(frame, size[0], size[1], output, size[0] * 4);

        var samples: [iterations]f64 = undefined;
        var checksum: u64 = 0;
        for (&samples, 0..) |*sample, index| {
            const started = std.Io.Clock.awake.now(init.io).nanoseconds;
            try frame_conversion.i420ToRgba(frame, size[0], size[1], output, size[0] * 4);
            const finished = std.Io.Clock.awake.now(init.io).nanoseconds;
            sample.* = @as(f64, @floatFromInt(finished - started)) / std.time.ns_per_ms;
            checksum ^= std.hash.Wyhash.hash(index, output);
        }
        std.mem.sort(f64, &samples, {}, std.sort.asc(f64));
        var sum: f64 = 0;
        for (samples) |sample| sum += sample;
        std.debug.print(
            "{d}x{d}: mean {d:.2} ms  p50 {d:.2} ms  p95 {d:.2} ms  max {d:.2} ms  checksum {x}\n",
            .{
                size[0],
                size[1],
                sum / iterations,
                samples[iterations / 2],
                samples[(iterations * 95) / 100 - 1],
                samples[iterations - 1],
                checksum,
            },
        );
    }
}
