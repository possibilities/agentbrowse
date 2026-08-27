const std = @import("std");
const klv = @import("kernel_live_view");

pub fn main(init: std.process.Init) !void {
    const allocator = init.arena.allocator();
    const args = try init.minimal.args.toSlice(allocator);
    if (args.len != 2 or !std.mem.eql(u8, args[1], "--connection-stdin")) {
        std.debug.print("usage: kernel-live-view --connection-stdin < connection.json\n", .{});
        return error.InvalidArguments;
    }

    var stdin_buffer: [4096]u8 = undefined;
    var stdin_reader = std.Io.File.stdin().readerStreaming(init.io, &stdin_buffer);
    const bytes = try stdin_reader.interface.allocRemaining(allocator, .limited(64 * 1024));
    const parsed = try klv.connection.parse(allocator, bytes);
    defer parsed.deinit();

    const summary = klv.redaction.summarize(parsed.value.base_url);
    std.debug.print("connecting to {s} ({s}, {s})\n", .{
        parsed.value.label,
        summary.scheme,
        @tagName(summary.location),
    });

    const live_session = try klv.session.Session.create(std.heap.page_allocator, parsed.value);
    defer live_session.deinit();
    live_session.connect();
    try live_session.run();
}
