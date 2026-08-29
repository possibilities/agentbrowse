const std = @import("std");
const connection = @import("../app/connection.zig");
const cursor_packets = @import("../protocol/cursor_packets.zig");
const cursor_state = @import("cursor_state.zig");
const frame_mod = @import("frame.zig");
const frame_queue = @import("frame_queue.zig");
const input_packets = @import("../protocol/input_packets.zig");
const input_state = @import("input_state.zig");
const native = @import("../platform/macos/native.zig");
const signaling = @import("../protocol/signaling.zig");
const state_mod = @import("state.zig");

pub const Metrics = struct {
    decoded_frames: u64,
    failed_frames: u64,
    headless_samples: u64,
    queued_frames: u64,
    replaced_frames: u64,
    pointer_events: u64,
    mapped_pointer_events: u64,
    key_events: u64,
    mapped_key_events: u64,
    data_packets_sent: u64,
    data_packets_failed: u64,
};

pub const Session = struct {
    allocator: std.mem.Allocator,
    descriptor: connection.Descriptor,
    native_handle: *native.Session,
    lifecycle: std.atomic.Value(u8) = .init(@intFromEnum(state_mod.State.idle)),
    data_open: std.atomic.Value(u8) = .init(0),
    authorized: std.atomic.Value(u8) = .init(0),
    remote_controller: std.atomic.Value(u8) = .init(0),
    implicit_hosting: std.atomic.Value(u8) = .init(0),
    control_requested: std.atomic.Value(u8) = .init(0),
    closed: std.atomic.Value(u8) = .init(0),
    reconnect_scheduled: std.atomic.Value(u8) = .init(0),
    reconnect_attempts: std.atomic.Value(u8) = .init(0),
    remote_width: std.atomic.Value(u32) = .init(0),
    remote_height: std.atomic.Value(u32) = .init(0),
    pointer_events: std.atomic.Value(u64) = .init(0),
    mapped_pointer_events: std.atomic.Value(u64) = .init(0),
    key_events: std.atomic.Value(u64) = .init(0),
    mapped_key_events: std.atomic.Value(u64) = .init(0),
    data_packets_sent: std.atomic.Value(u64) = .init(0),
    data_packets_failed: std.atomic.Value(u64) = .init(0),
    decoded_frames: std.atomic.Value(u64) = .init(0),
    failed_frames: std.atomic.Value(u64) = .init(0),
    headless_samples: std.atomic.Value(u64) = .init(0),
    id_mutex: std.atomic.Mutex = .unlocked,
    self_id: ?[]u8 = null,
    input_mutex: std.atomic.Mutex = .unlocked,
    held_input: input_state.InputState = .{},
    status_mutex: std.atomic.Mutex = .unlocked,
    status_bytes: [256]u8 = [_]u8{0} ** 256,
    status_len: u16 = 0,
    frames: frame_queue.Queue = .{},
    cursor: cursor_state.State = .{},

    pub fn create(allocator: std.mem.Allocator, descriptor: connection.Descriptor) !*Session {
        const self = try allocator.create(Session);
        errdefer allocator.destroy(self);
        self.* = undefined;
        const callbacks: native.Callbacks = .{
            .context = self,
            .on_websocket_message = onWebSocketMessage,
            .on_data_message = onDataMessage,
            .on_local_description = onLocalDescription,
            .on_local_candidate = onLocalCandidate,
            .on_state = onNativeState,
            .on_error = onNativeError,
            .on_frame = onFrame,
            .on_paste_ready = onPasteReady,
        };
        const native_handle = native.kl_native_create(callbacks) orelse return error.NativeInitializationFailed;
        self.* = .{
            .allocator = allocator,
            .descriptor = descriptor,
            .native_handle = native_handle,
        };
        self.setStatus("Ready");
        return self;
    }

    pub fn connect(self: *Session) void {
        self.setLifecycle(.connecting);
        self.setStatus("Connecting…");
        native.kl_native_connect(
            self.native_handle,
            self.descriptor.base_url.ptr,
            self.descriptor.base_url.len,
            self.descriptor.username.ptr,
            self.descriptor.username.len,
            self.descriptor.password.ptr,
            self.descriptor.password.len,
        );
    }

    pub fn close(self: *Session) void {
        if (self.closed.swap(1, .acq_rel) != 0) return;
        self.invalidateTransportState();
        self.setLifecycle(.closed);
        native.kl_native_close(self.native_handle);
        // Native close serializes behind any callback that was already using
        // the transport, so publish the terminal status after it returns.
        self.setStatus("Closed");
    }

    pub fn deinit(self: *Session) void {
        self.close();
        // Closing stops new transport work; destroying the native adapter also
        // waits for callbacks already inside Zig. Quiesce those callbacks before
        // releasing any Session-owned fields they may still be using.
        native.kl_native_destroy(self.native_handle);
        self.frames.clear();
        self.cursor.deinit(self.allocator);
        lock(&self.id_mutex);
        const old_id = self.self_id;
        self.self_id = null;
        self.id_mutex.unlock();
        if (old_id) |id| self.allocator.free(id);
        self.allocator.destroy(self);
    }

    pub fn acquireLatestFrame(self: *Session) ?frame_mod.Lease {
        return self.frames.acquireLatest();
    }

    pub fn acquireLatestFrameAfter(self: *Session, generation: u64) ?frame_mod.Lease {
        return self.frames.acquireLatestAfter(generation);
    }

    pub fn latestFrameGeneration(self: *Session) u64 {
        return self.frames.latestGeneration();
    }

    pub fn cursorSnapshot(self: *Session) cursor_state.Snapshot {
        return self.cursor.snapshot();
    }

    pub fn copyCursorImage(self: *Session, image_generation: u64, output: []u8) usize {
        return self.cursor.copyImage(image_generation, output);
    }

    pub fn nativeHandle(self: *Session) *native.Session {
        return self.native_handle;
    }

    pub fn remoteSize(self: *const Session) struct { width: u32, height: u32 } {
        return .{
            .width = self.remote_width.load(.acquire),
            .height = self.remote_height.load(.acquire),
        };
    }

    pub fn isDataOpen(self: *const Session) bool {
        return self.data_open.load(.acquire) != 0;
    }

    pub fn isAuthorized(self: *const Session) bool {
        return self.authorized.load(.acquire) != 0;
    }

    pub fn hasRemoteController(self: *const Session) bool {
        return self.remote_controller.load(.acquire) != 0;
    }

    pub fn isControlRequested(self: *const Session) bool {
        return self.control_requested.load(.acquire) != 0;
    }

    pub fn isReadOnly(self: *const Session) bool {
        return self.descriptor.read_only;
    }

    pub fn isClosed(self: *const Session) bool {
        return self.closed.load(.acquire) != 0;
    }

    pub fn state(self: *const Session) state_mod.State {
        return @enumFromInt(self.lifecycle.load(.acquire));
    }

    pub fn snapshotMetrics(self: *Session) Metrics {
        const frame_stats = self.frames.snapshotStats();
        return .{
            .decoded_frames = self.decoded_frames.load(.acquire),
            .failed_frames = self.failed_frames.load(.acquire),
            .headless_samples = self.headless_samples.load(.acquire),
            .queued_frames = frame_stats.published,
            .replaced_frames = frame_stats.replaced,
            .pointer_events = self.pointer_events.load(.acquire),
            .mapped_pointer_events = self.mapped_pointer_events.load(.acquire),
            .key_events = self.key_events.load(.acquire),
            .mapped_key_events = self.mapped_key_events.load(.acquire),
            .data_packets_sent = self.data_packets_sent.load(.acquire),
            .data_packets_failed = self.data_packets_failed.load(.acquire),
        };
    }

    pub fn requestControl(self: *Session) bool {
        if (self.descriptor.read_only or self.data_open.load(.acquire) == 0) return false;
        if (self.authorized.load(.acquire) != 0) return true;
        if (self.control_requested.swap(1, .acq_rel) != 0) return false;
        if (!self.sendEventEmpty("control/request")) {
            self.control_requested.store(0, .release);
            return false;
        }
        self.setStatus("Connected · requesting control");
        return true;
    }

    pub fn releaseControl(self: *Session) bool {
        if (self.descriptor.read_only) return false;
        self.releaseHeldInput();
        self.authorized.store(0, .release);
        self.remote_controller.store(0, .release);
        self.implicit_hosting.store(0, .release);
        self.control_requested.store(0, .release);
        return self.sendEventEmpty("control/release");
    }

    pub fn movePointer(self: *Session, x: u16, y: u16) bool {
        if (!self.ensureInput()) return false;
        const packet = input_packets.move(x, y);
        return self.sendPacket(&packet);
    }

    pub fn setPointerButton(self: *Session, button: u3, pressed: bool) bool {
        if (!self.ensureInput()) return false;
        lock(&self.input_mutex);
        if (pressed) self.held_input.pressButton(button) else self.held_input.releaseButton(button);
        self.input_mutex.unlock();
        const packet = input_packets.mouseButton(if (pressed) .down else .up, button);
        return self.sendPacket(&packet);
    }

    pub fn scroll(self: *Session, delta_x: i16, delta_y: i16, control_key: bool) bool {
        if (!self.ensureInput()) return false;
        const packet = input_packets.scroll(delta_x, delta_y, control_key);
        return self.sendPacket(&packet);
    }

    pub fn setKey(self: *Session, keysym_value: u64, pressed: bool, repeat: bool) bool {
        if (!self.ensureInput()) return false;
        lock(&self.input_mutex);
        const should_send = if (pressed)
            (self.held_input.pressKey(keysym_value) catch false) or repeat
        else
            self.held_input.releaseKey(keysym_value);
        self.input_mutex.unlock();
        return should_send and self.sendKey(if (pressed) .down else .up, keysym_value);
    }

    pub fn paste(self: *Session, text: []const u8) bool {
        if (text.len > 1024 * 1024 or !self.ensureInput()) return false;
        if (!self.sendEvent("clipboard/set", .{ .text = text })) return false;
        native.kl_native_schedule_paste(self.native_handle, 80);
        return true;
    }

    pub fn copyStatus(self: *Session, output: []u8) usize {
        lock(&self.status_mutex);
        defer self.status_mutex.unlock();
        const length = @min(output.len, @as(usize, self.status_len));
        @memcpy(output[0..length], self.status_bytes[0..length]);
        return length;
    }

    pub fn syncModifiers(self: *Session, flags: u64, modifiers: anytype) void {
        if (!self.ensureInput()) return;
        for (modifiers) |modifier| {
            var release_left = false;
            var release_right = false;
            var press_left = false;
            lock(&self.input_mutex);
            const left_held = self.held_input.isKeyHeld(modifier.left_keysym);
            const right_held = self.held_input.isKeyHeld(modifier.right_keysym);
            if ((flags & modifier.flag) != 0) {
                if (!left_held and !right_held) {
                    press_left = self.held_input.pressKey(modifier.left_keysym) catch false;
                }
            } else {
                if (left_held) release_left = self.held_input.releaseKey(modifier.left_keysym);
                if (right_held) release_right = self.held_input.releaseKey(modifier.right_keysym);
            }
            self.input_mutex.unlock();
            if (release_left) _ = self.sendKey(.up, modifier.left_keysym);
            if (release_right) _ = self.sendKey(.up, modifier.right_keysym);
            if (press_left) _ = self.sendKey(.down, modifier.left_keysym);
        }
    }

    pub fn notePointerEvent(self: *Session, mapped: bool) void {
        _ = self.pointer_events.fetchAdd(1, .monotonic);
        if (mapped) _ = self.mapped_pointer_events.fetchAdd(1, .monotonic);
    }

    pub fn noteKeyEvent(self: *Session, mapped: bool) void {
        _ = self.key_events.fetchAdd(1, .monotonic);
        if (mapped) _ = self.mapped_key_events.fetchAdd(1, .monotonic);
    }

    fn setLifecycle(self: *Session, value: state_mod.State) void {
        if (value != .closed and self.closed.load(.acquire) != 0) return;
        self.lifecycle.store(@intFromEnum(value), .release);
    }

    fn setStatus(self: *Session, message: []const u8) void {
        lock(&self.status_mutex);
        const length = @min(message.len, self.status_bytes.len);
        @memcpy(self.status_bytes[0..length], message[0..length]);
        self.status_len = @intCast(length);
        self.status_mutex.unlock();
    }

    fn scheduleReconnect(self: *Session) void {
        if (self.closed.load(.acquire) != 0) return;
        if (self.reconnect_scheduled.swap(1, .acq_rel) != 0) return;
        self.invalidateTransportState();
        self.setLifecycle(.reconnecting);
        self.setStatus("Connection interrupted · reconnecting…");
        const attempt = self.reconnect_attempts.fetchAdd(1, .acq_rel);
        native.kl_native_schedule_reconnect(self.native_handle, state_mod.reconnectDelayMs(attempt));
    }

    fn sendJson(self: *Session, value: anytype) bool {
        const bytes = std.json.Stringify.valueAlloc(self.allocator, value, .{}) catch return false;
        defer self.allocator.free(bytes);
        return native.kl_native_send_websocket(self.native_handle, bytes.ptr, bytes.len);
    }

    fn sendEvent(self: *Session, event: []const u8, payload: anytype) bool {
        return self.sendJson(.{ .event = event, .payload = payload });
    }

    fn sendEventEmpty(self: *Session, event: []const u8) bool {
        return self.sendJson(.{ .event = event });
    }

    fn requestPointerlessStream(self: *Session) bool {
        return self.sendEvent("signal/request", .{
            .video = .{
                .selector = .{
                    .type = "exact",
                    .id = "main",
                    .bitrate = @as(u64, 0),
                },
            },
            .audio = .{ .disabled = false },
            .auto = false,
        });
    }

    fn handleWebSocketMessage(self: *Session, bytes: []const u8) !void {
        switch (try signaling.eventFromJson(self.allocator, bytes)) {
            .signal_provide => {
                const Payload = struct {
                    event: []const u8,
                    payload: struct {
                        sdp: []const u8,
                        iceservers: std.json.Value,
                    },
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                const ice = try std.json.Stringify.valueAlloc(self.allocator, parsed.value.payload.iceservers, .{});
                defer self.allocator.free(ice);
                native.kl_native_create_peer(self.native_handle, ice.ptr, ice.len, false);
                native.kl_native_set_remote_description(
                    self.native_handle,
                    false,
                    parsed.value.payload.sdp.ptr,
                    parsed.value.payload.sdp.len,
                );
            },
            .signal_offer, .signal_answer => |event| {
                const Payload = struct {
                    event: []const u8,
                    payload: struct { sdp: []const u8 },
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                native.kl_native_set_remote_description(
                    self.native_handle,
                    event == .signal_answer,
                    parsed.value.payload.sdp.ptr,
                    parsed.value.payload.sdp.len,
                );
            },
            .signal_candidate => {
                const Payload = struct { event: []const u8, payload: std.json.Value };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                const candidate = try std.json.Stringify.valueAlloc(self.allocator, parsed.value.payload, .{});
                defer self.allocator.free(candidate);
                native.kl_native_add_ice_candidate(self.native_handle, candidate.ptr, candidate.len);
            },
            .system_init => {
                const Payload = struct {
                    event: []const u8,
                    payload: struct {
                        session_id: []const u8,
                        settings: struct {
                            heartbeat_interval: u32,
                            implicit_hosting: bool = false,
                        },
                        control_host: struct {
                            has_host: bool,
                            host_id: []const u8 = "",
                        },
                    },
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                try self.replaceSelfId(parsed.value.payload.session_id);
                self.implicit_hosting.store(@intFromBool(parsed.value.payload.settings.implicit_hosting), .release);
                self.applyControlHost(
                    parsed.value.payload.control_host.has_host,
                    parsed.value.payload.control_host.host_id,
                );
                if (parsed.value.payload.settings.heartbeat_interval > 0) {
                    native.kl_native_start_heartbeat(
                        self.native_handle,
                        parsed.value.payload.settings.heartbeat_interval * 1000,
                    );
                }
            },
            .control_host => {
                const Payload = struct {
                    event: []const u8,
                    payload: struct {
                        has_host: bool,
                        host_id: []const u8 = "",
                    },
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                self.applyControlHost(parsed.value.payload.has_host, parsed.value.payload.host_id);
            },
            .control_release => {
                self.authorized.store(0, .release);
                self.remote_controller.store(0, .release);
                self.control_requested.store(0, .release);
                self.releaseHeldInput();
                self.cursor.clearPosition();
                self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · control released");
            },
            .system_disconnect, .signal_close => {
                self.invalidateTransportState();
                self.setLifecycle(.failed);
                self.setStatus("Connection failed");
            },
            else => {},
        }
    }

    fn applyControlHost(self: *Session, has_host: bool, host_id: []const u8) void {
        self.control_requested.store(0, .release);
        self.cursor.clearPosition();
        const host_is_self = has_host and self.isSelf(host_id);
        self.remote_controller.store(@intFromBool(has_host and !host_is_self), .release);
        if (self.descriptor.read_only) {
            self.authorized.store(0, .release);
            self.releaseHeldInput();
            self.setStatus("Connected · read-only");
        } else if (host_is_self) {
            self.authorized.store(1, .release);
            self.setStatus("Connected · controlling");
        } else {
            self.authorized.store(0, .release);
            self.releaseHeldInput();
            self.setStatus(if (has_host) "Connected · waiting for control" else "Connected · control released");
        }
    }

    fn replaceSelfId(self: *Session, value: []const u8) !void {
        const copy = try self.allocator.dupe(u8, value);
        lock(&self.id_mutex);
        const old = self.self_id;
        self.self_id = copy;
        self.id_mutex.unlock();
        if (old) |id| self.allocator.free(id);
    }

    fn isSelf(self: *Session, value: []const u8) bool {
        lock(&self.id_mutex);
        defer self.id_mutex.unlock();
        return if (self.self_id) |id| std.mem.eql(u8, id, value) else false;
    }

    fn ensureInput(self: *Session) bool {
        if (self.descriptor.read_only or self.data_open.load(.acquire) == 0) return false;
        if (self.authorized.load(.acquire) != 0) return true;
        _ = self.requestControl();
        return false;
    }

    fn invalidateTransportState(self: *Session) void {
        // Revoke the gate first so no concurrent callback can enqueue new
        // input while failure teardown is clearing locally held state.
        self.revokeTransportState();
        self.releaseHeldInput();
    }

    fn revokeTransportState(self: *Session) void {
        self.authorized.store(0, .release);
        self.remote_controller.store(0, .release);
        self.control_requested.store(0, .release);
        self.implicit_hosting.store(0, .release);
        self.data_open.store(0, .release);
        self.cursor.reset(self.allocator);
    }

    fn sendPacket(self: *Session, bytes: []const u8) bool {
        if (native.kl_native_send_data(self.native_handle, bytes.ptr, bytes.len)) {
            _ = self.data_packets_sent.fetchAdd(1, .monotonic);
            return true;
        }
        _ = self.data_packets_failed.fetchAdd(1, .monotonic);
        return false;
    }

    fn sendKey(self: *Session, action: input_packets.KeyAction, keysym: u64) bool {
        const packet = input_packets.key(action, keysym);
        return self.sendPacket(&packet);
    }

    pub fn releaseHeldInput(self: *Session) void {
        var keys: [input_state.max_held_keys]u64 = undefined;
        var key_count: usize = 0;
        var buttons: u8 = 0;
        lock(&self.input_mutex);
        key_count = self.held_input.key_count;
        @memcpy(keys[0..key_count], self.held_input.keys[0..key_count]);
        buttons = self.held_input.buttons;
        self.held_input.clear();
        self.input_mutex.unlock();
        if (self.data_open.load(.acquire) == 0) return;
        for (keys[0..key_count]) |keysym_value| _ = self.sendKey(.up, keysym_value);
        for (0..8) |button| {
            if ((buttons & (@as(u8, 1) << @intCast(button))) == 0) continue;
            const packet = input_packets.mouseButton(.up, @intCast(button));
            _ = self.sendPacket(&packet);
        }
    }
};

fn fromContext(context: ?*anyopaque) *Session {
    return @ptrCast(@alignCast(context.?));
}

fn onWebSocketMessage(context: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    self.handleWebSocketMessage(bytes[0..len]) catch {
        self.invalidateTransportState();
        self.setLifecycle(.failed);
        self.setStatus("Protocol error");
    };
}

fn onDataMessage(context: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    const packet = cursor_packets.parse(bytes[0..len]) catch return;
    const value = packet orelse return;
    switch (value) {
        .position => |position| self.cursor.updatePosition(position),
        .image => |image| self.cursor.updateImage(self.allocator, image) catch {},
    }
}

fn onLocalDescription(context: ?*anyopaque, answer: bool, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    const sdp = bytes[0..len];
    if (answer) {
        _ = self.sendEvent("signal/answer", .{ .sdp = sdp });
    } else {
        _ = self.sendEvent("signal/offer", .{ .sdp = sdp });
    }
}

fn onLocalCandidate(context: ?*anyopaque, sdp_ptr: [*]const u8, sdp_len: usize, mid_ptr: [*]const u8, mid_len: usize, mline_index: i32) callconv(.c) void {
    const self = fromContext(context);
    _ = self.sendEvent("signal/candidate", .{
        .candidate = sdp_ptr[0..sdp_len],
        .sdpMid = mid_ptr[0..mid_len],
        .sdpMLineIndex = mline_index,
    });
}

fn onNativeState(context: ?*anyopaque, native_state: native.State) callconv(.c) void {
    const self = fromContext(context);
    switch (native_state) {
        .ws_open => {
            self.setStatus("Signaling connected · negotiating");
            if (!self.requestPointerlessStream()) self.setStatus("Could not request Live View stream");
        },
        .ws_closed, .peer_failed => {
            self.scheduleReconnect();
        },
        .peer_connecting => self.setStatus("WebRTC connecting…"),
        .peer_connected => {
            self.reconnect_attempts.store(0, .release);
            self.setLifecycle(.connected);
            self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · waiting for control");
        },
        .peer_disconnected => {
            self.invalidateTransportState();
            self.setLifecycle(.reconnecting);
            self.setStatus("Connection interrupted · recovering…");
        },
        .data_open => self.data_open.store(1, .release),
        .data_closed => self.invalidateTransportState(),
        .reconnect_ready => {
            // Native reset has now detached both old data channels. Clear once
            // more after that quiescence point so a cursor callback that ran
            // between the initial failure notification and reset cannot carry
            // stale observation state into the replacement transport.
            self.invalidateTransportState();
            self.reconnect_scheduled.store(0, .release);
            if (self.closed.load(.acquire) == 0) self.connect();
        },
    }
}

fn onNativeError(context: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    _ = bytes;
    _ = len;
    self.invalidateTransportState();
    self.setLifecycle(.failed);
    self.setStatus("Native transport error");
}

fn onFrame(context: ?*anyopaque, width: u32, height: u32, rotation: u16, timestamp_us: i64, y: [*]const u8, stride_y: u32, u: [*]const u8, stride_u: u32, v: [*]const u8, stride_v: u32) callconv(.c) void {
    const self = fromContext(context);
    const decoded = self.decoded_frames.fetchAdd(1, .monotonic) + 1;
    const chroma_height = (height + 1) / 2;
    const frame = frame_mod.Frame.createI420(
        self.allocator,
        width,
        height,
        rotation,
        timestamp_us,
        y[0 .. @as(usize, stride_y) * height],
        stride_y,
        u[0 .. @as(usize, stride_u) * chroma_height],
        stride_u,
        v[0 .. @as(usize, stride_v) * chroma_height],
        stride_v,
    ) catch {
        _ = self.failed_frames.fetchAdd(1, .monotonic);
        return;
    };
    self.remote_width.store(width, .release);
    self.remote_height.store(height, .release);
    self.frames.publish(frame);
    if (decoded == 1 or decoded % 100 == 0) noteFrameSample(self);
}

fn noteFrameSample(self: *Session) void {
    _ = self.headless_samples.fetchAdd(1, .monotonic);
}

fn onPasteReady(context: ?*anyopaque) callconv(.c) void {
    const self = fromContext(context);
    if (!self.ensureInput()) return;
    const control_l: u64 = 0xffe3;
    const v: u64 = 'v';
    lock(&self.input_mutex);
    const control_was_held = self.held_input.isKeyHeld(control_l);
    const v_was_held = self.held_input.isKeyHeld(v);
    self.input_mutex.unlock();
    if (!control_was_held) _ = self.sendKey(.down, control_l);
    if (!v_was_held) _ = self.sendKey(.down, v);
    if (!v_was_held) _ = self.sendKey(.up, v);
    if (!control_was_held) _ = self.sendKey(.up, control_l);
}

fn lock(mutex: *std.atomic.Mutex) void {
    while (!mutex.tryLock()) std.atomic.spinLoopHint();
}

test "transport state revocation closes every input gate" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{
            .version = connection.current_version,
            .label = "failure-test",
            .base_url = "http://127.0.0.1",
        },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    session.remote_controller.store(1, .release);
    session.control_requested.store(1, .release);
    session.implicit_hosting.store(1, .release);
    session.cursor.updatePosition(.{ .x = 10, .y = 20 });

    session.revokeTransportState();

    try std.testing.expect(!session.isDataOpen());
    try std.testing.expect(!session.isAuthorized());
    try std.testing.expect(!session.hasRemoteController());
    try std.testing.expect(!session.isControlRequested());
    try std.testing.expect(!session.cursorSnapshot().position_available);
}
