const std = @import("std");

pub const Location = enum { loopback, private, remote, invalid };

pub const UrlSummary = struct {
    scheme: []const u8,
    location: Location,
};

pub fn summarize(url: []const u8) UrlSummary {
    const scheme_end = std.mem.indexOf(u8, url, "://") orelse return .{
        .scheme = "invalid",
        .location = .invalid,
    };
    const scheme = url[0..scheme_end];
    const authority_start = scheme_end + 3;
    const authority_end = std.mem.indexOfScalarPos(u8, url, authority_start, '/') orelse url.len;
    const authority = url[authority_start..authority_end];
    const host_port = if (std.mem.lastIndexOfScalar(u8, authority, '@')) |at| authority[at + 1 ..] else authority;
    const host = if (std.mem.lastIndexOfScalar(u8, host_port, ':')) |colon| host_port[0..colon] else host_port;

    const location: Location = if (std.mem.eql(u8, host, "127.0.0.1") or
        std.mem.eql(u8, host, "localhost") or std.mem.eql(u8, host, "[::1]"))
        .loopback
    else if (std.mem.startsWith(u8, host, "10.") or std.mem.startsWith(u8, host, "192.168."))
        .private
    else
        .remote;
    return .{ .scheme = scheme, .location = location };
}

pub fn redactUrl(allocator: std.mem.Allocator, url: []const u8) ![]u8 {
    const query = std.mem.indexOfScalar(u8, url, '?') orelse url.len;
    const fragment = std.mem.indexOfScalar(u8, url[0..query], '#') orelse query;
    return allocator.dupe(u8, url[0..fragment]);
}

test "summarize without exposing query" {
    const summary = summarize("https://user:secret@example.com/live?token=secret");
    try std.testing.expectEqualStrings("https", summary.scheme);
    try std.testing.expectEqual(Location.remote, summary.location);

    const redacted = try redactUrl(std.testing.allocator, "https://example.com/live?token=secret");
    defer std.testing.allocator.free(redacted);
    try std.testing.expectEqualStrings("https://example.com/live", redacted);
}
