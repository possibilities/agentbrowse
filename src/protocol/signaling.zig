const std = @import("std");

pub const Event = enum {
    system_init,
    system_disconnect,
    system_error,
    system_pong,
    signal_provide,
    signal_offer,
    signal_answer,
    signal_candidate,
    member_list,
    member_connected,
    member_disconnected,
    control_locked,
    control_release,
    control_requesting,
    control_clipboard,
    screen_configurations,
    screen_resolution,
    unknown,
};

pub fn classify(name: []const u8) Event {
    const names = .{
        .{ "system/init", Event.system_init },
        .{ "system/disconnect", Event.system_disconnect },
        .{ "system/error", Event.system_error },
        .{ "system/pong", Event.system_pong },
        .{ "signal/provide", Event.signal_provide },
        .{ "signal/offer", Event.signal_offer },
        .{ "signal/answer", Event.signal_answer },
        .{ "signal/candidate", Event.signal_candidate },
        .{ "member/list", Event.member_list },
        .{ "member/connected", Event.member_connected },
        .{ "member/disconnected", Event.member_disconnected },
        .{ "control/locked", Event.control_locked },
        .{ "control/release", Event.control_release },
        .{ "control/requesting", Event.control_requesting },
        .{ "control/clipboard", Event.control_clipboard },
        .{ "screen/configurations", Event.screen_configurations },
        .{ "screen/resolution", Event.screen_resolution },
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
    try std.testing.expectEqual(Event.signal_provide, try eventFromJson(std.testing.allocator, "{\"event\":\"signal/provide\",\"sdp\":\"redacted\"}"));
    try std.testing.expectEqual(Event.unknown, try eventFromJson(std.testing.allocator, "{\"event\":\"future/event\"}"));
}
