const std = @import("std");

pub const Quantized = struct {
    delta_x: i16,
    delta_y: i16,

    pub fn isEmpty(self: Quantized) bool {
        return self.delta_x == 0 and self.delta_y == 0;
    }
};

const Bucket = struct {
    residual_x: f64 = 0,
    residual_y: f64 = 0,
    updated_at_ns: ?i128 = null,

    fn clear(self: *Bucket) void {
        self.* = .{};
    }
};

/// Fractional Neko scroll units, separated so ordinary trackpad motion can
/// never become a later Control-scroll browser zoom gesture.
pub const State = struct {
    buckets: [2]Bucket = .{ .{}, .{} },

    pub fn add(
        self: *State,
        delta_x: f64,
        delta_y: f64,
        control_key: bool,
        now_ns: i128,
        idle_reset_ns: i128,
    ) Quantized {
        std.debug.assert(std.math.isFinite(delta_x));
        std.debug.assert(std.math.isFinite(delta_y));
        const bucket = &self.buckets[@intFromBool(control_key)];
        if (bucket.updated_at_ns) |updated_at_ns| {
            if (now_ns < updated_at_ns or now_ns - updated_at_ns > idle_reset_ns) bucket.clear();
        }
        bucket.updated_at_ns = now_ns;

        const x = quantizeAxis(bucket.residual_x, delta_x);
        const y = quantizeAxis(bucket.residual_y, delta_y);
        bucket.residual_x = x.residual;
        bucket.residual_y = y.residual;
        return .{ .delta_x = x.units, .delta_y = y.units };
    }

    pub fn clearMode(self: *State, control_key: bool) void {
        self.buckets[@intFromBool(control_key)].clear();
    }

    pub fn clear(self: *State) void {
        self.* = .{};
    }
};

const AxisResult = struct {
    units: i16,
    residual: f64,
};

fn quantizeAxis(residual: f64, delta: f64) AxisResult {
    const total = residual + delta;
    if (!std.math.isFinite(total)) return .{
        .units = if (total < 0) std.math.minInt(i16) else std.math.maxInt(i16),
        .residual = 0,
    };
    const whole = @trunc(total);
    const clamped = @max(
        @as(f64, std.math.minInt(i16)),
        @min(@as(f64, std.math.maxInt(i16)), whole),
    );
    return .{
        .units = @intFromFloat(clamped),
        // Integer overflow is stale motion and is deliberately discarded;
        // only the sub-unit fraction participates in the next callback.
        .residual = total - whole,
    };
}

test "fractional scroll units accumulate per axis and truncate toward zero" {
    var state: State = .{};
    try std.testing.expect(state.add(0.5, -0.5, false, 10, 100).isEmpty());
    const whole = state.add(0.5, -0.5, false, 11, 100);
    try std.testing.expectEqual(@as(i16, 1), whole.delta_x);
    try std.testing.expectEqual(@as(i16, -1), whole.delta_y);

    try std.testing.expect(state.add(0.75, -0.75, false, 12, 100).isEmpty());
    const reversed = state.add(-1.75, 1.75, false, 13, 100);
    try std.testing.expectEqual(@as(i16, -1), reversed.delta_x);
    try std.testing.expectEqual(@as(i16, 1), reversed.delta_y);
}

test "ordinary and Control-scroll residuals are independent and clearable" {
    var state: State = .{};
    try std.testing.expect(state.add(0.75, 0, false, 10, 100).isEmpty());
    try std.testing.expect(state.add(0.5, 0, true, 11, 100).isEmpty());
    try std.testing.expectEqual(@as(i16, 1), state.add(0.5, 0, true, 12, 100).delta_x);
    try std.testing.expectEqual(@as(i16, 1), state.add(0.25, 0, false, 13, 100).delta_x);

    try std.testing.expect(state.add(0.75, 0, false, 14, 100).isEmpty());
    state.clearMode(false);
    try std.testing.expect(state.add(0.25, 0, false, 15, 100).isEmpty());
    state.clear();
    try std.testing.expect(state.add(0.75, 0, false, 16, 100).isEmpty());
}

test "idle buckets reset and saturation retains only fractional motion" {
    var state: State = .{};
    try std.testing.expect(state.add(0.75, 0, false, 10, 100).isEmpty());
    try std.testing.expect(state.add(0.5, 0, false, 111, 100).isEmpty());
    try std.testing.expectEqual(@as(i16, 1), state.add(0.5, 0, false, 112, 100).delta_x);

    const saturated = state.add(40_000.25, -40_000.75, true, 20, 100);
    try std.testing.expectEqual(std.math.maxInt(i16), saturated.delta_x);
    try std.testing.expectEqual(std.math.minInt(i16), saturated.delta_y);
    const remainder = state.add(0.75, 0.75, true, 21, 100);
    try std.testing.expectEqual(@as(i16, 1), remainder.delta_x);
    try std.testing.expectEqual(@as(i16, 0), remainder.delta_y);
}
