const std = @import("std");
const klv = @import("kernel_live_view");

const abi_version: u32 = 2;
const allocator = std.heap.page_allocator;
const max_descriptor_bytes: u32 = 64 * 1024;
const max_output_dimension: u32 = 8192;
const max_output_pixels: u64 = 32 * 1024 * 1024;

const AbiSession = struct {
    parsed: klv.connection.Parsed,
    live_session: *klv.session.Session,
    connect_called: std.atomic.Value(u8) = .init(0),
};

const AbiFrameLease = struct {
    lease: klv.frame.Lease,
};

const Snapshot = extern struct {
    struct_size: u32,
    abi_version: u32,
    lifecycle: u32,
    flags: u32,
    remote_width: u32,
    remote_height: u32,
    latest_frame_generation: u64,
};

const Metrics = extern struct {
    struct_size: u32,
    abi_version: u32,
    decoded_frames: u64,
    failed_frames: u64,
    frame_samples: u64,
    published_frames: u64,
    replaced_frames: u64,
    pointer_events: u64,
    mapped_pointer_events: u64,
    key_events: u64,
    mapped_key_events: u64,
    data_packets_sent: u64,
    data_packets_failed: u64,
};

const FrameInfo = extern struct {
    struct_size: u32,
    format: u32,
    width: u32,
    height: u32,
    display_width: u32,
    display_height: u32,
    rotation_degrees: u32,
    reserved: u32,
    generation: u64,
    timestamp_us: i64,
};

const CursorSnapshot = extern struct {
    struct_size: u32,
    abi_version: u32,
    flags: u32,
    width: u32,
    height: u32,
    hotspot_x: u32,
    hotspot_y: u32,
    position_x: u32,
    position_y: u32,
    image_byte_length: u32,
    generation: u64,
    image_generation: u64,
    position_generation: u64,
};

const Result = enum(u32) {
    ok = 0,
    invalid_argument = 1,
    closed = 2,
    buffer_too_small = 3,
    unsupported = 4,
    internal_error = 5,
};

comptime {
    if (@sizeOf(Snapshot) != 32) @compileError("ABLiveViewSnapshot layout changed");
    if (@sizeOf(Metrics) != 96) @compileError("ABLiveViewMetrics layout changed");
    if (@sizeOf(FrameInfo) != 48) @compileError("ABLiveViewFrameInfo layout changed");
    if (@sizeOf(CursorSnapshot) != 64) @compileError("ABLiveViewCursorSnapshot layout changed");
}

export fn ab_live_view_abi_version() callconv(.c) u32 {
    return abi_version;
}

export fn ab_live_view_session_create(
    descriptor_json: ?[*]const u8,
    descriptor_length: u32,
    error_output: ?[*]u8,
    error_capacity: u32,
) callconv(.c) ?*AbiSession {
    clearOutput(error_output, error_capacity);
    if (descriptor_json == null or descriptor_length == 0 or descriptor_length > max_descriptor_bytes) {
        writeError(error_output, error_capacity, "invalid connection descriptor");
        return null;
    }
    const parsed = klv.connection.parse(
        allocator,
        descriptor_json.?[0..descriptor_length],
    ) catch |err| {
        writeError(error_output, error_capacity, @errorName(err));
        return null;
    };
    errdefer parsed.deinit();
    const live_session = klv.session.Session.create(allocator, parsed.value) catch |err| {
        writeError(error_output, error_capacity, @errorName(err));
        return null;
    };
    errdefer live_session.deinit();
    const handle = allocator.create(AbiSession) catch {
        writeError(error_output, error_capacity, "OutOfMemory");
        return null;
    };
    handle.* = .{
        .parsed = parsed,
        .live_session = live_session,
    };
    return handle;
}

export fn ab_live_view_session_connect(handle: ?*AbiSession) callconv(.c) u32 {
    const session_handle = handle orelse return result(.invalid_argument);
    if (session_handle.live_session.isClosed()) return result(.closed);
    if (session_handle.connect_called.swap(1, .acq_rel) != 0) return result(.ok);
    session_handle.live_session.connect();
    return result(.ok);
}

export fn ab_live_view_session_close(handle: ?*AbiSession) callconv(.c) void {
    if (handle) |session_handle| session_handle.live_session.close();
}

export fn ab_live_view_session_destroy(handle: ?*AbiSession) callconv(.c) void {
    const session_handle = handle orelse return;
    session_handle.live_session.deinit();
    session_handle.parsed.deinit();
    allocator.destroy(session_handle);
}

export fn ab_live_view_session_snapshot(
    handle: ?*AbiSession,
    output: ?*Snapshot,
    output_size: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return result(.invalid_argument);
    const target = output orelse return result(.invalid_argument);
    if (output_size < @sizeOf(Snapshot)) return result(.buffer_too_small);
    const live_session = session_handle.live_session;
    const remote = live_session.remoteSize();
    var flags: u32 = 0;
    if (live_session.isDataOpen()) flags |= 1 << 0;
    if (live_session.isAuthorized()) flags |= 1 << 1;
    if (live_session.isControlRequested()) flags |= 1 << 2;
    if (live_session.isReadOnly()) flags |= 1 << 3;
    if (live_session.isClosed()) flags |= 1 << 4;
    target.* = .{
        .struct_size = @sizeOf(Snapshot),
        .abi_version = abi_version,
        .lifecycle = @intFromEnum(live_session.state()),
        .flags = flags,
        .remote_width = remote.width,
        .remote_height = remote.height,
        .latest_frame_generation = live_session.latestFrameGeneration(),
    };
    return result(.ok);
}

export fn ab_live_view_session_metrics(
    handle: ?*AbiSession,
    output: ?*Metrics,
    output_size: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return result(.invalid_argument);
    const target = output orelse return result(.invalid_argument);
    if (output_size < @sizeOf(Metrics)) return result(.buffer_too_small);
    const metrics = session_handle.live_session.snapshotMetrics();
    target.* = .{
        .struct_size = @sizeOf(Metrics),
        .abi_version = abi_version,
        .decoded_frames = metrics.decoded_frames,
        .failed_frames = metrics.failed_frames,
        .frame_samples = metrics.headless_samples,
        .published_frames = metrics.queued_frames,
        .replaced_frames = metrics.replaced_frames,
        .pointer_events = metrics.pointer_events,
        .mapped_pointer_events = metrics.mapped_pointer_events,
        .key_events = metrics.key_events,
        .mapped_key_events = metrics.mapped_key_events,
        .data_packets_sent = metrics.data_packets_sent,
        .data_packets_failed = metrics.data_packets_failed,
    };
    return result(.ok);
}

export fn ab_live_view_session_copy_status(
    handle: ?*AbiSession,
    output: ?[*]u8,
    output_capacity: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    if (output_capacity == 0) return 0;
    const target = output orelse return 0;
    return @intCast(session_handle.live_session.copyStatus(target[0..output_capacity]));
}

export fn ab_live_view_session_cursor_snapshot(
    handle: ?*AbiSession,
    output: ?*CursorSnapshot,
    output_size: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return result(.invalid_argument);
    const target = output orelse return result(.invalid_argument);
    if (output_size < @sizeOf(CursorSnapshot)) return result(.buffer_too_small);
    const cursor = session_handle.live_session.cursorSnapshot();
    var flags: u32 = 0;
    if (cursor.image_available) flags |= 1 << 0;
    if (cursor.position_available) flags |= 1 << 1;
    target.* = .{
        .struct_size = @sizeOf(CursorSnapshot),
        .abi_version = abi_version,
        .flags = flags,
        .width = cursor.width,
        .height = cursor.height,
        .hotspot_x = cursor.hotspot_x,
        .hotspot_y = cursor.hotspot_y,
        .position_x = cursor.position_x,
        .position_y = cursor.position_y,
        .image_byte_length = cursor.image_length,
        .generation = cursor.generation,
        .image_generation = cursor.image_generation,
        .position_generation = cursor.position_generation,
    };
    return result(.ok);
}

export fn ab_live_view_session_copy_cursor_image(
    handle: ?*AbiSession,
    image_generation: u64,
    output: ?[*]u8,
    output_capacity: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    if (output_capacity == 0) return 0;
    const target = output orelse return 0;
    return @intCast(session_handle.live_session.copyCursorImage(
        image_generation,
        target[0..output_capacity],
    ));
}

export fn ab_live_view_session_acquire_frame(
    handle: ?*AbiSession,
    after_generation: u64,
) callconv(.c) ?*AbiFrameLease {
    const session_handle = handle orelse return null;
    if (session_handle.live_session.isClosed()) return null;
    const frame_lease = session_handle.live_session.acquireLatestFrameAfter(after_generation) orelse return null;
    const lease_handle = allocator.create(AbiFrameLease) catch {
        var owned = frame_lease;
        owned.release();
        return null;
    };
    lease_handle.* = .{ .lease = frame_lease };
    return lease_handle;
}

export fn ab_live_view_frame_info(
    handle: ?*AbiFrameLease,
    output: ?*FrameInfo,
    output_size: u32,
) callconv(.c) u32 {
    const lease_handle = handle orelse return result(.invalid_argument);
    const target = output orelse return result(.invalid_argument);
    if (output_size < @sizeOf(FrameInfo)) return result(.buffer_too_small);
    const frame = lease_handle.lease.frame;
    target.* = .{
        .struct_size = @sizeOf(FrameInfo),
        .format = @intFromEnum(frame.format),
        .width = frame.width,
        .height = frame.height,
        .display_width = frame.displayWidth(),
        .display_height = frame.displayHeight(),
        .rotation_degrees = frame.rotation,
        .reserved = 0,
        .generation = frame.generation,
        .timestamp_us = frame.timestamp_us,
    };
    return result(.ok);
}

export fn ab_live_view_frame_convert_rgba(
    handle: ?*AbiFrameLease,
    output_width: u32,
    output_height: u32,
    output: ?[*]u8,
    output_stride: u32,
    output_capacity: u64,
) callconv(.c) u32 {
    const lease_handle = handle orelse return result(.invalid_argument);
    if (output == null or output_width == 0 or output_height == 0) return result(.invalid_argument);
    if (output_width > max_output_dimension or output_height > max_output_dimension) return result(.invalid_argument);
    const pixels = @as(u64, output_width) * output_height;
    if (pixels > max_output_pixels) return result(.invalid_argument);
    const row_bytes = std.math.mul(u32, output_width, 4) catch return result(.invalid_argument);
    if (output_stride < row_bytes) return result(.invalid_argument);
    const required = @as(u64, output_stride) * output_height;
    if (required > output_capacity or required > std.math.maxInt(usize)) return result(.buffer_too_small);
    klv.frame_conversion.i420ToRgba(
        lease_handle.lease.frame,
        output_width,
        output_height,
        output.?[0..@intCast(required)],
        output_stride,
    ) catch |err| return switch (err) {
        error.OutputTooSmall => result(.buffer_too_small),
        error.InvalidRotation => result(.unsupported),
        error.InvalidFrame, error.InvalidOutput => result(.invalid_argument),
    };
    return result(.ok);
}

export fn ab_live_view_frame_release(handle: ?*AbiFrameLease) callconv(.c) void {
    const lease_handle = handle orelse return;
    lease_handle.lease.release();
    allocator.destroy(lease_handle);
}

export fn ab_live_view_session_request_control(handle: ?*AbiSession) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    return @intFromBool(session_handle.live_session.requestControl());
}

export fn ab_live_view_session_release_control(handle: ?*AbiSession) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    return @intFromBool(session_handle.live_session.releaseControl());
}

export fn ab_live_view_session_pointer_move(handle: ?*AbiSession, x: u16, y: u16) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    session_handle.live_session.notePointerEvent(true);
    return @intFromBool(session_handle.live_session.movePointer(x, y));
}

export fn ab_live_view_session_pointer_button(
    handle: ?*AbiSession,
    button: u8,
    pressed: u8,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    if (button > 7) return 0;
    return @intFromBool(session_handle.live_session.setPointerButton(@intCast(button), pressed != 0));
}

export fn ab_live_view_session_scroll(
    handle: ?*AbiSession,
    delta_x: i16,
    delta_y: i16,
    control_key: u8,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    return @intFromBool(session_handle.live_session.scroll(delta_x, delta_y, control_key != 0));
}

export fn ab_live_view_session_key(
    handle: ?*AbiSession,
    keysym: u64,
    pressed: u8,
    repeat: u8,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    session_handle.live_session.noteKeyEvent(true);
    return @intFromBool(session_handle.live_session.setKey(keysym, pressed != 0, repeat != 0));
}

export fn ab_live_view_session_paste(
    handle: ?*AbiSession,
    utf8: ?[*]const u8,
    length: u32,
) callconv(.c) u32 {
    const session_handle = handle orelse return 0;
    if (length > 0 and utf8 == null) return 0;
    const bytes: []const u8 = if (length == 0) &.{} else utf8.?[0..length];
    return @intFromBool(session_handle.live_session.paste(bytes));
}

export fn ab_live_view_session_release_held_input(handle: ?*AbiSession) callconv(.c) void {
    if (handle) |session_handle| session_handle.live_session.releaseHeldInput();
}

fn result(value: Result) u32 {
    return @intFromEnum(value);
}

fn clearOutput(output: ?[*]u8, capacity: u32) void {
    if (output == null or capacity == 0) return;
    output.?[0] = 0;
}

fn writeError(output: ?[*]u8, capacity: u32, message: []const u8) void {
    if (output == null or capacity == 0) return;
    const content_capacity = capacity - 1;
    const length: usize = @min(message.len, content_capacity);
    @memcpy(output.?[0..length], message[0..length]);
    output.?[length] = 0;
}
