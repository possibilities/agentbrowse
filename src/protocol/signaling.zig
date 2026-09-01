const std = @import("std");

pub const Event = enum {
    system_init,
    system_error,
    system_disconnect,
    system_heartbeat,
    signal_provide,
    signal_offer,
    signal_answer,
    signal_candidate,
    signal_close,
    control_host,
    control_release,
    control_request,
    clipboard_updated,
    unknown,
};

pub fn classify(name: []const u8) Event {
    const names = .{
        .{ "system/init", Event.system_init },
        .{ "system/error", Event.system_error },
        .{ "system/disconnect", Event.system_disconnect },
        .{ "system/heartbeat", Event.system_heartbeat },
        .{ "signal/provide", Event.signal_provide },
        .{ "signal/offer", Event.signal_offer },
        .{ "signal/answer", Event.signal_answer },
        .{ "signal/candidate", Event.signal_candidate },
        .{ "signal/close", Event.signal_close },
        .{ "control/host", Event.control_host },
        .{ "control/release", Event.control_release },
        .{ "control/request", Event.control_request },
        .{ "clipboard/updated", Event.clipboard_updated },
    };
    inline for (names) |entry| if (std.mem.eql(u8, name, entry[0])) return entry[1];
    return .unknown;
}

pub const Envelope = struct { event: []const u8 };

pub fn eventFromJson(allocator: std.mem.Allocator, bytes: []const u8) !Event {
    const parsed = try std.json.parseFromSlice(Envelope, allocator, bytes, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    return classify(parsed.value.event);
}

test "classify known and unknown signaling events" {
    try std.testing.expectEqual(Event.signal_provide, try eventFromJson(std.testing.allocator, "{\"event\":\"signal/provide\",\"payload\":{\"sdp\":\"redacted\"}}"));
    try std.testing.expectEqual(Event.control_host, try eventFromJson(std.testing.allocator, "{\"event\":\"control/host\",\"payload\":{\"has_host\":true}}"));
    try std.testing.expectEqual(Event.system_error, try eventFromJson(std.testing.allocator, "{\"event\":\"system/error\",\"message\":\"backend failure\"}"));
    try std.testing.expectEqual(Event.clipboard_updated, try eventFromJson(std.testing.allocator, "{\"event\":\"clipboard/updated\",\"payload\":{\"text\":\"redacted\"}}"));
    try std.testing.expectEqual(Event.unknown, try eventFromJson(std.testing.allocator, "{\"event\":\"future/event\"}"));
}
