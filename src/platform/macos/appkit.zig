const std = @import("std");
const coordinates = @import("../../session/coordinates.zig");
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
        _ = live_session.scroll(
            normalizeScrollDelta(delta_x, precise),
            normalizeScrollDelta(delta_y, precise),
            control_key,
        );
        return;
    }
    if ((kind != 1 and kind != 2) or button > 7) return;
    _ = live_session.setPointerButton(@intCast(button), kind == 1);
}

fn onKey(context: ?*anyopaque, key_code: u16, modifiers: u64, pressed: bool, repeat: bool, characters: [*]const u8, characters_len: usize) callconv(.c) void {
    const live_session = fromContext(context);
    live_session.noteKeyEvent(false);
    const keysym_value = keymap.keysym(key_code, characters[0..characters_len]) orelse return;
    live_session.noteKeyEvent(true);
    // AppKit can deliver an ordinary key without a preceding flagsChanged
    // callback. Reconcile the modifier snapshot first so guest chords retain
    // their ordering.
    if (!keymap.isModifierKey(key_code)) live_session.syncModifiers(modifiers, &keymap.modifiers);
    _ = live_session.setKey(keysym_value, pressed, repeat);
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

fn normalizeScrollDelta(value: f64, precise: bool) i16 {
    const scale: f64 = if (precise) 4 else 19;
    return clampDelta(-value * scale);
}

test "scroll deltas follow macOS direction and Neko units" {
    try std.testing.expectEqual(@as(i16, -8), normalizeScrollDelta(2, true));
    try std.testing.expectEqual(@as(i16, 12), normalizeScrollDelta(-3, true));
    try std.testing.expectEqual(@as(i16, -19), normalizeScrollDelta(1, false));
}
