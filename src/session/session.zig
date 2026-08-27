const std = @import("std");
const connection = @import("../app/connection.zig");
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

    pub fn create(allocator: std.mem.Allocator, descriptor: connection.Descriptor) !*Session {
        const self = try allocator.create(Session);
        errdefer allocator.destroy(self);
        self.* = undefined;
        const callbacks: native.Callbacks = .{
            .context = self,
            .on_websocket_message = onWebSocketMessage,
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
        native.kl_native_connect_websocket(
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
        self.releaseHeldInput();
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
        if (!self.sendJson(.{ .event = "control/request" })) {
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
        self.implicit_hosting.store(0, .release);
        self.control_requested.store(0, .release);
        return self.sendJson(.{ .event = "control/release" });
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
        if (!self.sendJson(.{ .event = "control/clipboard", .text = text })) return false;
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
        self.authorized.store(0, .release);
        self.control_requested.store(0, .release);
        self.releaseHeldInput();
        self.data_open.store(0, .release);
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

    fn handleWebSocketMessage(self: *Session, bytes: []const u8) !void {
        switch (try signaling.eventFromJson(self.allocator, bytes)) {
            .signal_provide => {
                const Payload = struct {
                    event: []const u8,
                    id: []const u8,
                    lite: bool,
                    ice: std.json.Value,
                    sdp: []const u8,
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                try self.replaceSelfId(parsed.value.id);
                const ice = try std.json.Stringify.valueAlloc(self.allocator, parsed.value.ice, .{});
                defer self.allocator.free(ice);
                native.kl_native_create_peer(self.native_handle, ice.ptr, ice.len, parsed.value.lite);
                native.kl_native_set_remote_description(self.native_handle, false, parsed.value.sdp.ptr, parsed.value.sdp.len);
            },
            .signal_offer, .signal_answer => |event| {
                const Payload = struct { event: []const u8, sdp: []const u8 };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                native.kl_native_set_remote_description(self.native_handle, event == .signal_answer, parsed.value.sdp.ptr, parsed.value.sdp.len);
            },
            .signal_candidate => {
                const Payload = struct { event: []const u8, data: []const u8 };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                native.kl_native_add_ice_candidate(self.native_handle, parsed.value.data.ptr, parsed.value.data.len);
            },
            .system_init => {
                const Payload = struct {
                    event: []const u8,
                    heartbeat_interval: u32,
                    implicit_hosting: bool = false,
                };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                self.implicit_hosting.store(@intFromBool(parsed.value.implicit_hosting), .release);
                if (parsed.value.heartbeat_interval > 0) {
                    native.kl_native_start_heartbeat(self.native_handle, parsed.value.heartbeat_interval * 1000);
                }
            },
            .control_locked => {
                const Payload = struct { event: []const u8, id: []const u8 };
                const parsed = try std.json.parseFromSlice(Payload, self.allocator, bytes, .{ .ignore_unknown_fields = true });
                defer parsed.deinit();
                if (self.descriptor.read_only) {
                    self.authorized.store(0, .release);
                    self.control_requested.store(0, .release);
                    self.releaseHeldInput();
                    self.setStatus("Connected · read-only");
                } else if (self.isSelf(parsed.value.id)) {
                    self.authorized.store(1, .release);
                    self.control_requested.store(0, .release);
                    self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · controlling");
                } else {
                    self.authorized.store(0, .release);
                    self.releaseHeldInput();
                    self.setStatus("Connected · waiting for control");
                }
            },
            .control_release => {
                self.authorized.store(0, .release);
                self.releaseHeldInput();
                self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · control released");
            },
            .system_disconnect, .system_error => {
                self.setLifecycle(.failed);
                self.releaseHeldInput();
                self.setStatus("Connection failed");
            },
            else => {},
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
        self.setLifecycle(.failed);
        self.releaseHeldInput();
        self.setStatus("Protocol error");
    };
}

fn onLocalDescription(context: ?*anyopaque, answer: bool, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    const sdp = bytes[0..len];
    if (answer) {
        _ = self.sendJson(.{ .event = "signal/answer", .sdp = sdp, .displayname = self.descriptor.username });
    } else {
        _ = self.sendJson(.{ .event = "signal/offer", .sdp = sdp });
    }
}

fn onLocalCandidate(context: ?*anyopaque, sdp_ptr: [*]const u8, sdp_len: usize, mid_ptr: [*]const u8, mid_len: usize, mline_index: i32) callconv(.c) void {
    const self = fromContext(context);
    const inner = std.json.Stringify.valueAlloc(self.allocator, .{
        .candidate = sdp_ptr[0..sdp_len],
        .sdpMid = mid_ptr[0..mid_len],
        .sdpMLineIndex = mline_index,
    }, .{}) catch return;
    defer self.allocator.free(inner);
    _ = self.sendJson(.{ .event = "signal/candidate", .data = inner });
}

fn onNativeState(context: ?*anyopaque, native_state: native.State) callconv(.c) void {
    const self = fromContext(context);
    std.debug.print("native state: {s}\n", .{@tagName(native_state)});
    switch (native_state) {
        .ws_open => self.setStatus("Signaling connected · negotiating"),
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
            self.setLifecycle(.reconnecting);
            self.releaseHeldInput();
            self.setStatus("Connection interrupted · recovering…");
        },
        .data_open => self.data_open.store(1, .release),
        .data_closed => {
            self.data_open.store(0, .release);
            self.releaseHeldInput();
        },
        .reconnect_ready => {
            self.reconnect_scheduled.store(0, .release);
            if (self.closed.load(.acquire) == 0) self.connect();
        },
    }
}

fn onNativeError(context: ?*anyopaque, bytes: [*]const u8, len: usize) callconv(.c) void {
    const self = fromContext(context);
    std.debug.print("native error: {s}\n", .{bytes[0..len]});
    self.setLifecycle(.failed);
    self.releaseHeldInput();
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
    if (decoded == 1 or decoded % 100 == 0) logFrameSample(self);
}

fn logFrameSample(self: *Session) void {
    var lease = self.acquireLatestFrame() orelse return;
    defer lease.release();
    _ = self.headless_samples.fetchAdd(1, .monotonic);
    const metrics = self.snapshotMetrics();
    std.debug.print(
        "video metrics: {d}x{d} i420 decoded={d} failed={d} replaced={d} checksum={x}\n",
        .{
            lease.frame.width,
            lease.frame.height,
            metrics.decoded_frames,
            metrics.failed_frames,
            metrics.replaced_frames,
            frame_mod.checksum(lease.frame),
        },
    );
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
