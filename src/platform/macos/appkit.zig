const std = @import("std");
const connection = @import("../../app/connection.zig");
const coordinates = @import("../../session/coordinates.zig");
const input_packets = @import("../../protocol/input_packets.zig");
const keymap = @import("keymap.zig");
const native = @import("native.zig");
const session_mod = @import("../../session/session.zig");

pub fn attach(live_session: *session_mod.Session) !void {
    const callbacks: native.AppKitCallbacks = .{
        .context = live_session,
        .on_pointer = onPointer,
        .on_key = onKey,
        .on_paste = onPaste,
        .on_focus = onFocus,
        .on_close = onClose,
        .copy_status = copyStatus,
        .copy_cursor_snapshot = copyCursorSnapshot,
        .copy_cursor_image = copyCursorImage,
    };
    const label = live_session.descriptor.label;
    if (!native.kl_native_attach_appkit(live_session.nativeHandle(), callbacks, label.ptr, label.len)) {
        return error.AppKitInitializationFailed;
    }
}

pub fn run(live_session: *session_mod.Session) !void {
    if (native.kl_native_run_appkit(live_session.nativeHandle()) != 0) {
        return error.NativeApplicationFailed;
    }
}

fn fromContext(context: ?*anyopaque) *session_mod.Session {
    return @ptrCast(@alignCast(context.?));
}

fn onPointer(context: ?*anyopaque, x: f64, y: f64, view_width: f64, view_height: f64, kind: u8, button: u8, delta_x: f64, delta_y: f64, control_key: bool) callconv(.c) void {
    const live_session = fromContext(context);
    live_session.notePointerEvent(false);
    const remote = live_session.remoteSize();
    const remote_width: u16 = @intCast(@min(remote.width, std.math.maxInt(u16)));
    const remote_height: u16 = @intCast(@min(remote.height, std.math.maxInt(u16)));
    const fitted = coordinates.aspectFit(.{
        .x = 0,
        .y = 0,
        .width = view_width,
        .height = view_height,
    }, .{
        .width = @floatFromInt(remote_width),
        .height = @floatFromInt(remote_height),
    }) orelse return;
    const mapped = coordinates.mapPoint(
        .{ .x = x, .y = y },
        fitted,
        remote_width,
        remote_height,
        true,
    ) orelse {
        // AppKit continues a captured drag outside the fitted video. Release
        // the guest button even when there is no new guest coordinate.
        if (kind == 2 and button <= 7) {
            _ = live_session.setPointerButton(@intCast(button), false);
        }
        return;
    };
    live_session.notePointerEvent(true);
    _ = live_session.movePointer(mapped.x, mapped.y);
    if (kind == 3 or kind == 4) {
        const precise = kind == 3;
        if (precise) {
            _ = live_session.scrollPrecise(
                normalizePrecisionScrollDelta(delta_x),
                normalizePrecisionScrollDelta(delta_y),
                control_key,
            );
        } else {
            _ = live_session.scroll(
                normalizeDiscreteScrollDelta(delta_x),
                normalizeDiscreteScrollDelta(delta_y),
                control_key,
            );
        }
        return;
    }
    if ((kind != 1 and kind != 2) or button > 7) return;
    _ = live_session.setPointerButton(@intCast(button), kind == 1);
}

fn onKey(context: ?*anyopaque, key_code: u16, modifiers: u64, pressed: bool, repeat: bool, characters: [*]const u8, characters_len: usize) callconv(.c) void {
    const live_session = fromContext(context);
    live_session.noteKeyEvent(false);
    const character_bytes = characters[0..characters_len];
    const keysym_value = keymap.keysym(key_code, character_bytes);
    const modifier_only = keymap.isModifierKey(key_code);
    const target: ?session_mod.PhysicalKeyTarget = if (!pressed or modifier_only or keysym_value == null)
        null
    else
        keymap.shortcutTranslation(key_code, modifiers, character_bytes) orelse
            keymap.physicalTarget(key_code, keysym_value.?);
    const handled = live_session.setPhysicalKey(.{
        .physical_id = key_code,
        .modifier_flags = modifiers,
        .keysym = keysym_value,
        .pressed = pressed,
        .repeat = repeat,
        .modifier_only = modifier_only,
        .target = target,
    }, &keymap.modifiers);
    if (handled or keysym_value != null) live_session.noteKeyEvent(true);
}

fn onPaste(context: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) void {
    _ = fromContext(context).paste(bytes[0..len]);
}

fn onFocus(context: ?*anyopaque, focused: bool) callconv(.c) void {
    if (!focused) fromContext(context).releaseHeldInput();
}

fn onClose(context: ?*anyopaque) callconv(.c) void {
    fromContext(context).close();
}

fn copyStatus(context: ?*anyopaque, output: [*]u8, output_capacity: u32) callconv(.c) u32 {
    const written = fromContext(context).copyStatus(output[0..output_capacity]);
    return @intCast(written);
}

fn copyCursorSnapshot(
    context: ?*anyopaque,
    output: *native.AppKitCursorSnapshot,
    output_size: u32,
) callconv(.c) bool {
    if (output_size < @sizeOf(native.AppKitCursorSnapshot)) return false;
    const live_session = fromContext(context);
    const cursor = live_session.cursorSnapshot();
    var flags: u32 = 0;
    if (cursor.image_available) flags |= 1 << 0;
    if (cursor.position_available) flags |= 1 << 1;
    if (live_session.isAuthorized()) flags |= 1 << 2;
    if (live_session.hasRemoteController()) flags |= 1 << 3;
    output.* = .{
        .struct_size = @sizeOf(native.AppKitCursorSnapshot),
        .flags = flags,
        .width = cursor.width,
        .height = cursor.height,
        .hotspot_x = cursor.hotspot_x,
        .hotspot_y = cursor.hotspot_y,
        .position_x = cursor.position_x,
        .position_y = cursor.position_y,
        .image_byte_length = cursor.image_length,
        .reserved = 0,
        .generation = cursor.generation,
        .image_generation = cursor.image_generation,
        .position_generation = cursor.position_generation,
    };
    return true;
}

fn copyCursorImage(
    context: ?*anyopaque,
    image_generation: u64,
    output: [*]u8,
    output_capacity: u32,
) callconv(.c) u32 {
    return @intCast(fromContext(context).copyCursorImage(
        image_generation,
        output[0..output_capacity],
    ));
}

fn clampDelta(value: f64) i16 {
    if (!std.math.isFinite(value)) return 0;
    const clamped = @max(
        @as(f64, std.math.minInt(i16)),
        @min(@as(f64, std.math.maxInt(i16)), @round(value)),
    );
    return @intFromFloat(clamped);
}

fn normalizePrecisionScrollDelta(value: f64) f64 {
    return -value * 4;
}

fn normalizeDiscreteScrollDelta(value: f64) i16 {
    if (!std.math.isFinite(value) or value == 0) return 0;
    const magnitude = @max(@abs(value), 1);
    const tick = if (value < 0) -magnitude else magnitude;
    return clampDelta(-tick * 120);
}

test "scroll deltas follow macOS direction and Neko units" {
    try std.testing.expectEqual(@as(f64, -8), normalizePrecisionScrollDelta(2));
    try std.testing.expectEqual(@as(f64, 12), normalizePrecisionScrollDelta(-3));
    try std.testing.expectEqual(@as(i16, -120), normalizeDiscreteScrollDelta(0.1));
    try std.testing.expectEqual(@as(i16, 120), normalizeDiscreteScrollDelta(-0.1));
    try std.testing.expectEqual(@as(i16, -156), normalizeDiscreteScrollDelta(1.3));
    try std.testing.expectEqual(@as(i16, 0), normalizeDiscreteScrollDelta(0));
    try std.testing.expectEqual(@as(i16, 0), normalizeDiscreteScrollDelta(std.math.inf(f64)));
}

const KeyPacketRecorder = struct {
    packets: [32][11]u8 = undefined,
    count: usize = 0,
};

fn recordKeyPacket(context: ?*anyopaque, bytes: []const u8) bool {
    const recorder: *KeyPacketRecorder = @ptrCast(@alignCast(context.?));
    std.debug.assert(bytes.len == 11);
    @memcpy(&recorder.packets[recorder.count], bytes);
    recorder.count += 1;
    return true;
}

test "translated AppKit key-up restores the current physical modifiers" {
    var session: session_mod.Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "appkit-shortcut-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: KeyPacketRecorder = .{};
    session.packet_sink_context = &recorder;
    session.packet_sink = recordKeyPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    const character = "C";

    onKey(&session, 8, keymap.command_flag | keymap.shift_flag, true, false, character.ptr, character.len);
    // AppKit reports the Command flagsChanged release before the character
    // key-up. That modifier event restores the physical Shift-only snapshot;
    // releasing C must not synthesize another Control tap.
    onKey(&session, 55, keymap.shift_flag, false, false, "".ptr, 0);
    onKey(&session, 8, keymap.shift_flag, false, false, character.ptr, character.len);

    const expected = [_][11]u8{
        input_packets.key(.down, 0xffe1),
        input_packets.key(.down, 0xffe3),
        input_packets.key(.down, 'C'),
        input_packets.key(.up, 0xffe3),
        input_packets.key(.up, 'C'),
    };
    try std.testing.expectEqual(expected.len, recorder.count);
    for (expected, 0..) |packet, index| {
        try std.testing.expectEqualSlices(u8, &packet, &recorder.packets[index]);
    }
    try std.testing.expect(!session.physical_keys.hasActive());
}

test "AppKit modifier sides reconcile and translations do not leak into unrelated keys" {
    var session: session_mod.Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "appkit-shortcut-isolation-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: KeyPacketRecorder = .{};
    session.packet_sink_context = &recorder;
    session.packet_sink = recordKeyPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    const empty = "";

    // Right Command is deliberately reconciled through the side-neutral
    // modifier path, which consistently owns Meta_L.
    onKey(&session, 54, keymap.command_flag, true, false, empty.ptr, empty.len);
    onKey(&session, 8, keymap.command_flag, true, false, "c".ptr, 1);
    // B is not translated. Even while translated C remains down, B sees the
    // physical Command snapshot rather than an aggregate forced Control.
    onKey(&session, 11, keymap.command_flag, true, false, "b".ptr, 1);
    onKey(&session, 11, keymap.command_flag, false, false, "b".ptr, 1);
    onKey(&session, 8, keymap.command_flag, false, false, "c".ptr, 1);
    onKey(&session, 54, 0, false, false, empty.ptr, empty.len);

    const expected = [_][11]u8{
        input_packets.key(.down, 0xffe7),
        input_packets.key(.down, 0xffe3),
        input_packets.key(.up, 0xffe7),
        input_packets.key(.down, 'c'),
        input_packets.key(.up, 0xffe3),
        input_packets.key(.down, 0xffe7),
        input_packets.key(.down, 'b'),
        input_packets.key(.up, 'b'),
        input_packets.key(.up, 'c'),
        input_packets.key(.up, 0xffe7),
    };
    try std.testing.expectEqual(expected.len, recorder.count);
    for (expected, 0..) |packet, index| {
        try std.testing.expectEqualSlices(u8, &packet, &recorder.packets[index]);
    }
    try std.testing.expectEqual(@as(usize, 0), session.held_input.key_count);
    try std.testing.expect(!session.physical_keys.hasActive());
}

test "translated AppKit history navigation forces Alt and restores Command on release" {
    var session: session_mod.Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "appkit-history-navigation-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: KeyPacketRecorder = .{};
    session.packet_sink_context = &recorder;
    session.packet_sink = recordKeyPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    const empty = "";
    const bracket = "[";

    onKey(&session, 55, keymap.command_flag, true, false, empty.ptr, empty.len);
    // Command-[ is Linux Chrome's Alt-Left. The forced Option flag reaches the
    // guest as Alt_L while the physical Meta is withdrawn for the chord.
    onKey(&session, 33, keymap.command_flag, true, false, bracket.ptr, bracket.len);
    // Releasing [ while Command is still held restores the physical Meta
    // snapshot; the later Command flagsChanged release then clears it.
    onKey(&session, 33, keymap.command_flag, false, false, bracket.ptr, bracket.len);
    onKey(&session, 55, 0, false, false, empty.ptr, empty.len);

    const expected = [_][11]u8{
        input_packets.key(.down, 0xffe7),
        input_packets.key(.down, 0xffe9),
        input_packets.key(.up, 0xffe7),
        input_packets.key(.down, 0xff51),
        input_packets.key(.up, 0xff51),
        input_packets.key(.up, 0xffe9),
        input_packets.key(.down, 0xffe7),
        input_packets.key(.up, 0xffe7),
    };
    try std.testing.expectEqual(expected.len, recorder.count);
    for (expected, 0..) |packet, index| {
        try std.testing.expectEqualSlices(u8, &packet, &recorder.packets[index]);
    }
    try std.testing.expectEqual(@as(usize, 0), session.held_input.key_count);
    try std.testing.expect(!session.physical_keys.hasActive());
}
