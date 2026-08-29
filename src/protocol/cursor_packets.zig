const std = @import("std");

pub const max_image_bytes: usize = 1024 * 1024;
pub const max_dimension: u16 = 1024;

pub const Position = struct {
    x: u16,
    y: u16,
};

pub const Image = struct {
    width: u16,
    height: u16,
    hotspot_x: u16,
    hotspot_y: u16,
    png: []const u8,
};

pub const Packet = union(enum) {
    position: Position,
    image: Image,
};

const png_signature = [_]u8{ 0x89, 'P', 'N', 'G', 0x0d, 0x0a, 0x1a, 0x0a };
const ihdr_type = [_]u8{ 'I', 'H', 'D', 'R' };

pub fn parse(bytes: []const u8) !?Packet {
    if (bytes.len < 3) return error.TruncatedHeader;
    const declared_length = std.mem.readInt(u16, bytes[1..3], .big);
    if (declared_length != bytes.len) return error.InvalidLength;

    return switch (bytes[0]) {
        0x01 => try parsePosition(bytes),
        0x02 => try parseImage(bytes),
        else => null,
    };
}

fn parsePosition(bytes: []const u8) !Packet {
    if (bytes.len != 7) return error.InvalidPositionLength;
    return .{ .position = .{
        .x = std.mem.readInt(u16, bytes[3..5], .big),
        .y = std.mem.readInt(u16, bytes[5..7], .big),
    } };
}

fn parseImage(bytes: []const u8) !Packet {
    if (bytes.len < 11) return error.InvalidImageLength;
    const png = bytes[11..];
    if (png.len == 0 or png.len > max_image_bytes) return error.InvalidImageLength;
    if (png.len < png_signature.len or !std.mem.eql(u8, png[0..png_signature.len], &png_signature)) {
        return error.InvalidPng;
    }
    const width = std.mem.readInt(u16, bytes[3..5], .big);
    const height = std.mem.readInt(u16, bytes[5..7], .big);
    if (width == 0 or height == 0 or width > max_dimension or height > max_dimension) {
        return error.InvalidImageDimensions;
    }
    const hotspot_x = std.mem.readInt(u16, bytes[7..9], .big);
    const hotspot_y = std.mem.readInt(u16, bytes[9..11], .big);
    if (hotspot_x >= width or hotspot_y >= height) return error.InvalidHotspot;
    try validatePngHeader(png, width, height);
    return .{ .image = .{
        .width = width,
        .height = height,
        .hotspot_x = hotspot_x,
        .hotspot_y = hotspot_y,
        .png = png,
    } };
}

fn validatePngHeader(png: []const u8, width: u16, height: u16) !void {
    // PNG requires IHDR to be the first chunk. Validate the dimensions that
    // AppKit will actually decode rather than trusting the parallel Neko
    // metadata alone; this keeps a small packet from declaring a huge image.
    if (png.len < 33 or
        std.mem.readInt(u32, png[8..12], .big) != 13 or
        !std.mem.eql(u8, png[12..16], &ihdr_type))
    {
        return error.InvalidPng;
    }
    const png_width = std.mem.readInt(u32, png[16..20], .big);
    const png_height = std.mem.readInt(u32, png[20..24], .big);
    if (png_width != width or png_height != height) return error.InvalidImageDimensions;
}

test "parse Neko cursor position and image packets" {
    const position = [_]u8{ 0x01, 0x00, 0x07, 0x12, 0x34, 0xab, 0xcd };
    const parsed_position = (try parse(&position)).?;
    try std.testing.expectEqual(@as(u16, 0x1234), parsed_position.position.x);
    try std.testing.expectEqual(@as(u16, 0xabcd), parsed_position.position.y);

    const encoded_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const png_length = comptime try std.base64.standard.Decoder.calcSizeForSlice(encoded_png);
    var png: [png_length]u8 = undefined;
    try std.base64.standard.Decoder.decode(&png, encoded_png);
    var image: [11 + png_length]u8 = undefined;
    image[0] = 0x02;
    std.mem.writeInt(u16, image[1..3], image.len, .big);
    std.mem.writeInt(u16, image[3..5], 1, .big);
    std.mem.writeInt(u16, image[5..7], 1, .big);
    std.mem.writeInt(u16, image[7..9], 0, .big);
    std.mem.writeInt(u16, image[9..11], 0, .big);
    @memcpy(image[11..], &png);
    const parsed_image = (try parse(&image)).?;
    try std.testing.expectEqual(@as(u16, 1), parsed_image.image.width);
    try std.testing.expectEqual(@as(u16, 1), parsed_image.image.height);
    try std.testing.expectEqual(@as(u16, 0), parsed_image.image.hotspot_x);
    try std.testing.expectEqual(@as(u16, 0), parsed_image.image.hotspot_y);
    try std.testing.expectEqualSlices(u8, &png, parsed_image.image.png);
}

test "reject malformed cursor packets and ignore future opcodes" {
    try std.testing.expectError(error.TruncatedHeader, parse(&.{ 0x01, 0x00 }));
    try std.testing.expectError(error.InvalidLength, parse(&.{ 0x01, 0x00, 0x07 }));
    var invalid_hotspot = [_]u8{0} ** 44;
    invalid_hotspot[0] = 0x02;
    std.mem.writeInt(u16, invalid_hotspot[1..3], invalid_hotspot.len, .big);
    std.mem.writeInt(u16, invalid_hotspot[3..5], 8, .big);
    std.mem.writeInt(u16, invalid_hotspot[5..7], 8, .big);
    std.mem.writeInt(u16, invalid_hotspot[7..9], 8, .big);
    @memcpy(invalid_hotspot[11 .. 11 + png_signature.len], &png_signature);
    try std.testing.expectError(error.InvalidHotspot, parse(&invalid_hotspot));
    try std.testing.expectError(error.InvalidPng, parse(&.{
        0x02, 0x00, 0x13,
        0x00, 0x01, 0x00,
        0x01, 0x00, 0x00,
        0x00, 0x00, 0x89,
        'P',  'N',  'G',
        0x0d, 0x0a, 0x1a,
        0x0a,
    }));
    try std.testing.expect((try parse(&.{ 0x7f, 0x00, 0x03 })) == null);
}
