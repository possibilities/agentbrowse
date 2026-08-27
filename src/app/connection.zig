const std = @import("std");

pub const current_version: u16 = 1;

pub const Descriptor = struct {
    version: u16,
    label: []const u8,
    base_url: []const u8,
    username: []const u8 = "kernel",
    password: []const u8 = "",
    read_only: bool = false,
};

pub const Parsed = std.json.Parsed(Descriptor);

pub fn parse(allocator: std.mem.Allocator, bytes: []const u8) !Parsed {
    if (bytes.len == 0) return error.EmptyDescriptor;
    if (bytes.len > 64 * 1024) return error.DescriptorTooLarge;

    const parsed = try std.json.parseFromSlice(Descriptor, allocator, bytes, .{});
    errdefer parsed.deinit();
    try validate(parsed.value);
    return parsed;
}

pub fn validate(descriptor: Descriptor) !void {
    if (descriptor.version != current_version) return error.UnsupportedDescriptorVersion;
    if (descriptor.label.len == 0 or descriptor.label.len > 128) return error.InvalidLabel;
    if (descriptor.username.len > 256 or descriptor.password.len > 4096) return error.InvalidCredential;
    if (!(std.mem.startsWith(u8, descriptor.base_url, "http://") or
        std.mem.startsWith(u8, descriptor.base_url, "https://")))
    {
        return error.InvalidBaseUrl;
    }
    if (descriptor.base_url.len > 8192) return error.InvalidBaseUrl;
}

test "parse connection descriptor" {
    const source =
        \\{"version":1,"label":"artbird/local","base_url":"http://127.0.0.1:18080","username":"kernel","password":"secret","read_only":true}
    ;
    const parsed = try parse(std.testing.allocator, source);
    defer parsed.deinit();
    try std.testing.expectEqual(current_version, parsed.value.version);
    try std.testing.expectEqualStrings("artbird/local", parsed.value.label);
    try std.testing.expect(parsed.value.read_only);
}

test "reject unknown fields and unsafe URL schemes" {
    const unknown =
        \\{"version":1,"label":"local","base_url":"http://127.0.0.1","token":"nope"}
    ;
    try std.testing.expectError(error.UnknownField, parse(std.testing.allocator, unknown));

    const unsafe =
        \\{"version":1,"label":"local","base_url":"file:///tmp/socket"}
    ;
    try std.testing.expectError(error.InvalidBaseUrl, parse(std.testing.allocator, unsafe));
}
