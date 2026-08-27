const std = @import("std");

pub const State = enum { idle, connecting, connected, reconnecting, closed, failed };
pub const Event = enum { connect, connected, temporary_disconnect, recovered, permanent_failure, close };

pub fn reconnectDelayMs(attempt: u8) u32 {
    const shift: u5 = @intCast(@min(attempt, 4));
    return @min(@as(u32, 1000) << shift, 10_000);
}

pub fn transition(current: State, event: Event) !State {
    return switch (current) {
        .idle => switch (event) {
            .connect => .connecting,
            .close => .closed,
            else => error.InvalidTransition,
        },
        .connecting => switch (event) {
            .connected => .connected,
            .permanent_failure => .failed,
            .close => .closed,
            else => error.InvalidTransition,
        },
        .connected => switch (event) {
            .temporary_disconnect => .reconnecting,
            .permanent_failure => .failed,
            .close => .closed,
            else => error.InvalidTransition,
        },
        .reconnecting => switch (event) {
            .recovered => .connected,
            .permanent_failure => .failed,
            .close => .closed,
            else => error.InvalidTransition,
        },
        .failed => switch (event) {
            .connect => .connecting,
            .close => .closed,
            else => error.InvalidTransition,
        },
        .closed => error.InvalidTransition,
    };
}

test "connection lifecycle" {
    var current: State = .idle;
    current = try transition(current, .connect);
    current = try transition(current, .connected);
    current = try transition(current, .temporary_disconnect);
    current = try transition(current, .recovered);
    current = try transition(current, .close);
    try std.testing.expectEqual(State.closed, current);
    try std.testing.expectError(error.InvalidTransition, transition(current, .connect));
}

test "reconnect delay is bounded exponential backoff" {
    try std.testing.expectEqual(@as(u32, 1000), reconnectDelayMs(0));
    try std.testing.expectEqual(@as(u32, 8000), reconnectDelayMs(3));
    try std.testing.expectEqual(@as(u32, 10_000), reconnectDelayMs(8));
}
