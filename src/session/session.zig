const std = @import("std");
const builtin = @import("builtin");
const connection = @import("../app/connection.zig");
const cursor_packets = @import("../protocol/cursor_packets.zig");
const cursor_state = @import("cursor_state.zig");
const frame_mod = @import("frame.zig");
const frame_queue = @import("frame_queue.zig");
const input_event = @import("input_event.zig");
const input_metrics = @import("input_metrics.zig");
const input_packets = @import("../protocol/input_packets.zig");
const input_state = @import("input_state.zig");
const pending_input = @import("pending_input.zig");
const physical_key_state = @import("physical_key_state.zig");
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

pub const PhysicalKeyTarget = physical_key_state.Target;

pub const PhysicalKeyEvent = struct {
    physical_id: u32,
    modifier_flags: u64,
    keysym: ?u64,
    pressed: bool,
    repeat: bool = false,
    modifier_only: bool = false,
    target: ?PhysicalKeyTarget = null,
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
    control_request_started_ns: ?i128 = null,
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
    admission_mutex: AdmissionMutex = .{},
    input_queue: pending_input.Queue = .{},
    input_draining: bool = false,
    input_epoch: u64 = 0,
    input_sequence: u64 = 0,
    input_in_flight: ?InFlightInput = null,
    input_counters: input_metrics.Counters = .{},
    packet_sink_context: ?*anyopaque = null,
    packet_sink: ?*const fn (?*anyopaque, []const u8) bool = null,
    paste_sink_context: ?*anyopaque = null,
    paste_sink: ?*const fn (?*anyopaque, []const u8) bool = null,
    held_input: input_state.InputState = .{},
    physical_keys: physical_key_state.State = .{},
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
            .on_frame_metadata = onFrameMetadata,
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

    pub fn snapshotInputMetrics(self: *Session) input_metrics.Snapshot {
        self.admission_mutex.lock();
        defer self.admission_mutex.unlock();
        return self.input_counters.snapshot(
            @intCast(self.input_queue.len()),
            @intCast(self.input_queue.capacity()),
            self.input_epoch,
        );
    }

    pub fn requestControl(self: *Session) bool {
        const now_ns = monotonicNowNs();
        self.admission_mutex.lock();
        if (self.descriptor.read_only or self.data_open.load(.acquire) == 0) {
            self.admission_mutex.unlock();
            return false;
        }
        if (self.authorized.load(.acquire) != 0) {
            self.admission_mutex.unlock();
            return true;
        }
        const claimed = self.claimControlRequestLocked(now_ns);
        self.admission_mutex.unlock();
        return claimed and self.sendClaimedControlRequest(now_ns);
    }

    pub fn releaseControl(self: *Session) bool {
        if (self.descriptor.read_only) return false;
        self.admission_mutex.lock();
        self.cancelInputLocked(monotonicNowNs());
        const held = self.takeHeldInputLocked();
        self.authorized.store(0, .release);
        self.remote_controller.store(0, .release);
        self.clearControlRequestLocked();
        self.admission_mutex.unlock();
        self.sendHeldInputReleases(held);
        return self.sendEventEmpty("control/release");
    }

    pub fn movePointer(self: *Session, x: u16, y: u16) bool {
        self.input_counters.note(.move, .attempted);
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.input_counters.note(.move, .control_dropped);
            self.admission_mutex.unlock();
            return false;
        }
        const sequence = self.nextInputSequenceLocked();
        const outcome = self.input_queue.pushMove(
            self.allocator,
            sequence,
            self.input_epoch,
            x,
            y,
            admission.route == .wait,
            now_ns,
        );
        const should_drain = self.recordPushOutcomeLocked(.move, outcome, admission.route, now_ns);
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (!outcome.accepted()) return false;
        return if (should_drain) self.drainInputQueue(if (outcome.result == .queued) sequence else null) else true;
    }

    pub fn setPointerButton(self: *Session, button: u3, pressed: bool) bool {
        self.input_counters.note(.button, .attempted);
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.input_counters.note(.button, .control_dropped);
            self.admission_mutex.unlock();
            return false;
        }
        var desired = self.desiredInputLocked() catch {
            self.input_counters.note(.button, .control_dropped);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        };
        const change: input_event.StateChange = .{ .button = .{ .button = button, .pressed = pressed } };
        if (!input_event.changeNeeded(change, &desired)) {
            self.input_counters.note(.button, .duplicate_suppressed);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        }
        input_event.applyChange(change, &desired) catch {
            self.input_counters.note(.button, .control_dropped);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        };
        const sequence = self.nextInputSequenceLocked();
        const outcome = self.input_queue.pushButton(
            self.allocator,
            sequence,
            self.input_epoch,
            button,
            pressed,
            admission.route == .wait,
            now_ns,
        );
        const should_drain = self.recordPushOutcomeLocked(.button, outcome, admission.route, now_ns);
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (!outcome.accepted()) return false;
        return if (should_drain) self.drainInputQueue(sequence) else true;
    }

    pub fn scroll(self: *Session, delta_x: i16, delta_y: i16, control_key: bool) bool {
        self.input_counters.note(.scroll, .attempted);
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.input_counters.note(.scroll, .control_dropped);
            self.admission_mutex.unlock();
            return false;
        }
        const sequence = self.nextInputSequenceLocked();
        const outcome = self.input_queue.pushScroll(
            self.allocator,
            sequence,
            self.input_epoch,
            delta_x,
            delta_y,
            control_key,
            admission.route == .wait,
            now_ns,
        );
        const should_drain = self.recordPushOutcomeLocked(.scroll, outcome, admission.route, now_ns);
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (!outcome.accepted()) return false;
        return if (should_drain) self.drainInputQueue(if (outcome.result == .queued) sequence else null) else true;
    }

    pub fn setKey(self: *Session, keysym_value: u64, pressed: bool, repeat: bool) bool {
        _ = repeat;
        self.input_counters.note(.key, .attempted);
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.input_counters.note(.key, .control_dropped);
            self.admission_mutex.unlock();
            return false;
        }
        var desired = self.desiredInputLocked() catch {
            self.input_counters.note(.key, .control_dropped);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        };
        const change: input_event.StateChange = .{ .key = .{ .keysym = keysym_value, .pressed = pressed } };
        if (!input_event.changeNeeded(change, &desired)) {
            self.input_counters.note(.key, .duplicate_suppressed);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        }
        input_event.applyChange(change, &desired) catch {
            self.input_counters.note(.key, .control_dropped);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        };
        const sequence = self.nextInputSequenceLocked();
        const outcome = self.input_queue.pushKey(
            self.allocator,
            sequence,
            self.input_epoch,
            keysym_value,
            pressed,
            admission.route == .wait,
            now_ns,
        );
        const should_drain = self.recordPushOutcomeLocked(.key, outcome, admission.route, now_ns);
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (!outcome.accepted()) return false;
        return if (should_drain) self.drainInputQueue(sequence) else true;
    }

    pub fn paste(self: *Session, text: []const u8) bool {
        self.input_counters.note(.paste, .attempted);
        if (text.len == 0 or text.len > pending_input.max_paste_bytes) {
            self.input_counters.note(.paste, .control_dropped);
            return false;
        }
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.input_counters.note(.paste, .control_dropped);
            self.admission_mutex.unlock();
            return false;
        }
        const sequence = self.nextInputSequenceLocked();
        const outcome = self.input_queue.pushPaste(
            self.allocator,
            sequence,
            self.input_epoch,
            text,
            admission.route == .wait,
            now_ns,
        );
        const should_drain = self.recordPushOutcomeLocked(.paste, outcome, admission.route, now_ns);
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (!outcome.accepted()) return false;
        return if (should_drain) self.drainInputQueue(sequence) else true;
    }

    pub fn copyStatus(self: *Session, output: []u8) usize {
        lock(&self.status_mutex);
        defer self.status_mutex.unlock();
        const length = @min(output.len, @as(usize, self.status_len));
        @memcpy(output[0..length], self.status_bytes[0..length]);
        return length;
    }

    pub fn syncModifiers(self: *Session, flags: u64, modifiers: anytype) void {
        var transitions: [16]KeyTransition = undefined;
        var transition_count: usize = 0;
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.admission_mutex.unlock();
            return;
        }
        var desired = self.desiredInputLocked() catch {
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return;
        };
        appendModifierTransitions(
            flags,
            modifiers,
            &desired,
            &transitions,
            &transition_count,
        );
        const should_drain = self.enqueueKeyBatchLocked(
            transitions[0..transition_count],
            admission.route,
            now_ns,
        );
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (should_drain) _ = self.drainInputQueue(null);
    }

    /// Admit one AppKit physical-key event as an indivisible modifier/target
    /// batch. The remembered target makes key-up independent of later layout
    /// or modifier changes, while unrelated keys always use physical flags.
    pub fn setPhysicalKey(self: *Session, event: PhysicalKeyEvent, modifiers: anytype) bool {
        _ = event.repeat;
        const target_attempted = !event.modifier_only;
        var transitions: [32]KeyTransition = undefined;
        var transition_count: usize = 0;

        self.admission_mutex.lock();
        const stored_target = self.physical_keys.get(event.physical_id);
        const target = stored_target orelse if (event.pressed) event.target else null;
        if (target) |value| std.debug.assert(value.physical_id == event.physical_id);
        const target_keysym = if (target) |value| value.keysym else event.keysym;
        if (!event.modifier_only and target_keysym == null) {
            if (!event.pressed) _ = self.physical_keys.take(event.physical_id);
            self.admission_mutex.unlock();
            return false;
        }

        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            if (target_attempted) {
                self.input_counters.note(.key, .attempted);
                self.input_counters.note(.key, .control_dropped);
            }
            if (!event.pressed) _ = self.physical_keys.take(event.physical_id);
            self.admission_mutex.unlock();
            return false;
        }
        var desired = self.desiredInputLocked() catch {
            if (target_attempted) {
                self.input_counters.note(.key, .attempted);
                self.input_counters.note(.key, .control_dropped);
            }
            if (!event.pressed) _ = self.physical_keys.take(event.physical_id);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        };

        if (event.modifier_only) {
            appendModifierTransitions(
                event.modifier_flags,
                modifiers,
                &desired,
                &transitions,
                &transition_count,
            );
        } else {
            if (event.pressed) {
                const effective_flags = if (target) |value|
                    (physical_key_state.ModifierTransform{
                        .removed = value.removed_modifiers,
                        .forced = value.forced_modifiers,
                    }).apply(event.modifier_flags)
                else
                    event.modifier_flags;
                appendModifierTransitions(
                    effective_flags,
                    modifiers,
                    &desired,
                    &transitions,
                    &transition_count,
                );
            }

            const change: input_event.StateChange = .{ .key = .{
                .keysym = target_keysym.?,
                .pressed = event.pressed,
            } };
            if (input_event.changeNeeded(change, &desired)) {
                std.debug.assert(transition_count < transitions.len);
                transitions[transition_count] = .{
                    .keysym = target_keysym.?,
                    .pressed = event.pressed,
                };
                transition_count += 1;
                input_event.applyChange(change, &desired) catch {
                    self.input_counters.note(.key, .attempted);
                    self.input_counters.note(.key, .control_dropped);
                    if (!event.pressed) _ = self.physical_keys.take(event.physical_id);
                    self.admission_mutex.unlock();
                    if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
                    return false;
                };
            } else {
                self.input_counters.note(.key, .attempted);
                self.input_counters.note(.key, .duplicate_suppressed);
            }

            if (!event.pressed and stored_target != null) {
                appendModifierTransitions(
                    event.modifier_flags,
                    modifiers,
                    &desired,
                    &transitions,
                    &transition_count,
                );
            }
        }

        const waiting = admission.route == .wait;
        if (transition_count != 0 and !self.input_queue.canAppend(transition_count, waiting)) {
            _ = self.enqueueKeyBatchLocked(
                transitions[0..transition_count],
                admission.route,
                now_ns,
            );
            if (!event.pressed) _ = self.physical_keys.take(event.physical_id);
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return false;
        }

        if (event.pressed) {
            if (stored_target == null) {
                if (event.target) |candidate| _ = self.physical_keys.remember(candidate);
            }
        } else {
            _ = self.physical_keys.take(event.physical_id);
        }
        const should_drain = self.enqueueKeyBatchLocked(
            transitions[0..transition_count],
            admission.route,
            now_ns,
        );
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (should_drain) _ = self.drainInputQueue(null);
        return event.modifier_only or transition_count != 0;
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
            .system_error => self.applyLegacyControlError(),
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
                self.applyControlRelease();
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
        var held: HeldInput = .{};
        var release_held = false;
        var should_drain = false;
        const now_ns = monotonicNowNs();
        self.admission_mutex.lock();
        self.clearControlRequestLocked();
        self.cursor.clearPosition();
        const host_is_self = has_host and self.isSelf(host_id);
        self.remote_controller.store(@intFromBool(has_host and !host_is_self), .release);
        if (self.descriptor.read_only) {
            self.authorized.store(0, .release);
            self.cancelInputLocked(now_ns);
            held = self.takeHeldInputLocked();
            release_held = true;
            self.setStatus("Connected · read-only");
        } else if (host_is_self) {
            self.authorized.store(1, .release);
            self.setStatus("Connected · controlling");
            if (self.input_queue.expireWait(self.allocator, now_ns)) |expired| {
                self.recordClearResultLocked(expired);
            }
            if (self.input_queue.finishWait(now_ns)) |duration| self.input_counters.noteControlWait(duration);
            should_drain = self.claimInputDrainerLocked();
        } else {
            self.authorized.store(0, .release);
            self.cancelInputLocked(now_ns);
            held = self.takeHeldInputLocked();
            release_held = true;
            self.setStatus(if (has_host) "Connected · waiting for control" else "Connected · control released");
        }
        self.admission_mutex.unlock();
        if (release_held) self.sendHeldInputReleases(held);
        if (should_drain) _ = self.drainInputQueue(null);
    }

    fn applyControlRelease(self: *Session) void {
        self.admission_mutex.lock();
        self.authorized.store(0, .release);
        self.remote_controller.store(0, .release);
        self.clearControlRequestLocked();
        self.cancelInputLocked(monotonicNowNs());
        const held = self.takeHeldInputLocked();
        self.cursor.clearPosition();
        self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · control released");
        self.admission_mutex.unlock();
        self.sendHeldInputReleases(held);
    }

    fn applyLegacyControlError(self: *Session) void {
        // The deployed v3 WebSocket silently refuses control, but Neko's
        // legacy proxy can report a generic backend failure as system/error.
        var held: HeldInput = .{};
        self.admission_mutex.lock();
        if (self.control_requested.load(.acquire) == 0 or self.authorized.load(.acquire) != 0) {
            self.admission_mutex.unlock();
            return;
        }
        self.clearControlRequestLocked();
        self.cancelInputLocked(monotonicNowNs());
        held = self.takeHeldInputLocked();
        self.setStatus(if (self.descriptor.read_only) "Connected · read-only" else "Connected · control unavailable");
        self.admission_mutex.unlock();
        self.sendHeldInputReleases(held);
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

    fn inputRouteLocked(self: *Session, now_ns: i128) InputAdmission {
        const route = classifyInputRoute(
            self.descriptor.read_only,
            self.data_open.load(.acquire) != 0,
            self.authorized.load(.acquire) != 0,
            self.implicit_hosting.load(.acquire) != 0,
        );
        if (route == .reject or self.authorized.load(.acquire) != 0) {
            return .{ .route = route };
        }
        _ = self.expireControlRequestLocked(now_ns);
        // A pending semantic batch has the same two-second lifetime even if
        // its request latch was reset after a failed send.
        if (route == .wait) {
            if (self.input_queue.expireWait(self.allocator, now_ns)) |expired| {
                self.recordClearResultLocked(expired);
                self.clearControlRequestLocked();
            }
        }
        const request_control = self.claimControlRequestLocked(now_ns);
        return .{ .route = route, .request_control = request_control };
    }

    fn claimControlRequestLocked(self: *Session, now_ns: i128) bool {
        if (self.control_requested.swap(1, .acq_rel) != 0) return false;
        self.control_request_started_ns = now_ns;
        return true;
    }

    fn sendClaimedControlRequest(self: *Session, started_ns: i128) bool {
        if (builtin.is_test) return true;
        if (!self.sendEventEmpty("control/request")) {
            self.admission_mutex.lock();
            if (self.control_request_started_ns == started_ns) self.clearControlRequestLocked();
            self.admission_mutex.unlock();
            return false;
        }
        self.admission_mutex.lock();
        if (self.control_request_started_ns == started_ns and self.authorized.load(.acquire) == 0) {
            self.setStatus("Connected · requesting control");
        }
        self.admission_mutex.unlock();
        return true;
    }

    fn expireControlRequestLocked(self: *Session, now_ns: i128) bool {
        const started = self.control_request_started_ns orelse return false;
        if (now_ns < started or now_ns - started < pending_input.max_age_ns) return false;
        self.clearControlRequestLocked();
        return true;
    }

    fn clearControlRequestLocked(self: *Session) void {
        self.control_requested.store(0, .release);
        self.control_request_started_ns = null;
    }

    fn cancelInputLocked(self: *Session, now_ns: i128) void {
        const cleared = self.input_queue.clear(self.allocator, now_ns);
        self.recordClearResultLocked(cleared);
        self.input_epoch +%= 1;
    }

    fn invalidateTransportState(self: *Session) void {
        // Revoke the gate first so no concurrent callback can enqueue new
        // input while failure teardown is clearing locally held state.
        self.admission_mutex.lock();
        self.revokeTransportState();
        _ = self.takeHeldInputLocked();
        self.admission_mutex.unlock();
    }

    fn revokeTransportState(self: *Session) void {
        self.authorized.store(0, .release);
        self.remote_controller.store(0, .release);
        self.clearControlRequestLocked();
        self.implicit_hosting.store(0, .release);
        self.data_open.store(0, .release);
        self.cancelInputLocked(monotonicNowNs());
        self.cursor.reset(self.allocator);
    }

    fn sendPaste(self: *Session, text: []const u8) bool {
        if (self.paste_sink) |sink| return sink(self.paste_sink_context, text);
        if (builtin.is_test) return true;
        if (!self.sendEvent("clipboard/set", .{ .text = text })) return false;
        native.kl_native_schedule_paste(self.native_handle, 80);
        return true;
    }

    fn nextInputSequenceLocked(self: *Session) u64 {
        self.input_sequence +%= 1;
        return self.input_sequence;
    }

    fn inputDeliverableLocked(self: *Session) bool {
        return !self.descriptor.read_only and
            self.data_open.load(.acquire) != 0 and
            (self.authorized.load(.acquire) != 0 or self.implicit_hosting.load(.acquire) != 0);
    }

    fn claimInputDrainerLocked(self: *Session) bool {
        if (self.input_draining or self.input_queue.len() == 0 or !self.inputDeliverableLocked()) return false;
        self.input_draining = true;
        return true;
    }

    fn recordPushOutcomeLocked(self: *Session, kind: input_event.Kind, outcome: pending_input.PushOutcome, route: InputRoute, now_ns: i128) bool {
        _ = now_ns;
        self.input_counters.noteCounts(outcome.abandoned, .control_dropped);
        if (outcome.wait_duration_ns) |duration| self.input_counters.noteControlWait(duration);
        if (route == .wait and outcome.accepted()) self.input_counters.note(kind, .queued);
        if (outcome.result == .coalesced) self.input_counters.note(kind, .coalesced);
        if (!outcome.accepted()) self.input_counters.note(kind, .control_dropped);
        return outcome.accepted() and route == .deliver and self.claimInputDrainerLocked();
    }

    fn recordClearResultLocked(self: *Session, cleared: pending_input.ClearResult) void {
        self.input_counters.noteCounts(cleared.abandoned, .control_dropped);
        if (cleared.wait_duration_ns) |duration| self.input_counters.noteControlWait(duration);
    }

    fn desiredInputLocked(self: *Session) !input_state.InputState {
        var desired = self.held_input;
        if (self.input_in_flight) |in_flight| {
            if (in_flight.epoch == self.input_epoch) try input_event.applyChange(in_flight.change, &desired);
        }
        for (0..self.input_queue.len()) |index| {
            const queued = self.input_queue.entry(index);
            if (queued.epoch == self.input_epoch) try queued.event.applyDesired(&desired);
        }
        return desired;
    }

    fn enqueueKeyBatchLocked(self: *Session, transitions: []const KeyTransition, route: InputRoute, now_ns: i128) bool {
        if (transitions.len == 0) return false;
        for (transitions) |_| self.input_counters.note(.key, .attempted);
        const waiting = route == .wait;
        if (!self.input_queue.canAppend(transitions.len, waiting)) {
            if (waiting and !self.input_queue.aborted) {
                self.recordClearResultLocked(self.input_queue.abortWait(self.allocator, now_ns));
            }
            self.input_counters.noteMany(.key, .control_dropped, transitions.len);
            return false;
        }
        for (transitions) |transition| {
            const outcome = self.input_queue.pushKey(
                self.allocator,
                self.nextInputSequenceLocked(),
                self.input_epoch,
                transition.keysym,
                transition.pressed,
                waiting,
                now_ns,
            );
            std.debug.assert(outcome.result == .queued);
            if (waiting) self.input_counters.note(.key, .queued);
        }
        return route == .deliver and self.claimInputDrainerLocked();
    }

    fn drainInputQueue(self: *Session, tracked_sequence: ?u64) bool {
        var tracked_result: ?bool = null;
        while (true) {
            self.admission_mutex.lock();
            if (self.input_queue.len() == 0 or !self.inputDeliverableLocked()) {
                // Cancellers never clear ownership. The active drainer alone
                // relinquishes it under the lock; a non-empty explicit-control
                // wait is claimed again by applyControlHost after authorization.
                self.input_draining = false;
                self.admission_mutex.unlock();
                return tracked_result orelse true;
            }
            var entry = self.input_queue.pop().?;
            if (entry.epoch != self.input_epoch) {
                self.input_counters.note(entry.event.kind(), .control_dropped);
                if (tracked_sequence == entry.sequence) tracked_result = false;
                self.admission_mutex.unlock();
                entry.event.deinit(self.allocator);
                continue;
            }
            const change = entry.event.stateChange();
            if (change) |state_change| {
                if (!input_event.changeNeeded(state_change, &self.held_input)) {
                    self.input_counters.note(entry.event.kind(), .duplicate_suppressed);
                    if (tracked_sequence == entry.sequence) tracked_result = false;
                    self.admission_mutex.unlock();
                    entry.event.deinit(self.allocator);
                    continue;
                }
                self.input_in_flight = .{
                    .sequence = entry.sequence,
                    .epoch = entry.epoch,
                    .change = state_change,
                };
            }
            self.admission_mutex.unlock();

            const outcome: InputSendOutcome = if (self.data_open.load(.acquire) == 0)
                .skipped
            else if (self.sendInputEvent(entry.event))
                .sent
            else
                .failed;

            self.admission_mutex.lock();
            if (change != null) self.input_in_flight = null;
            const same_epoch = entry.epoch == self.input_epoch;
            var committed = change == null;
            if (outcome == .sent) {
                self.input_counters.note(entry.event.kind(), .sent);
                if (same_epoch) {
                    if (change) |state_change| {
                        input_event.applyChange(state_change, &self.held_input) catch {
                            committed = false;
                        };
                        committed = input_event.changeNeeded(state_change, &self.held_input) == false;
                    }
                }
            } else if (outcome == .failed) {
                self.input_counters.note(entry.event.kind(), .send_failed);
            }
            if (!same_epoch or (outcome == .sent and !committed)) {
                self.input_counters.note(entry.event.kind(), .control_dropped);
            }
            const compensate = outcome == .sent and (!same_epoch or !committed) and
                if (change) |state_change| input_event.isDown(state_change) else false;
            if (tracked_sequence == entry.sequence) {
                tracked_result = outcome == .sent and same_epoch and committed;
            }
            self.admission_mutex.unlock();

            if (compensate and self.data_open.load(.acquire) != 0) {
                self.sendCompensatingRelease(change.?);
            }
            entry.event.deinit(self.allocator);
        }
    }

    fn sendInputEvent(self: *Session, event: input_event.Event) bool {
        return switch (event) {
            .move => |position| self.sendPacket(&input_packets.move(position.x, position.y)),
            .button => |button| self.sendPacket(&input_packets.mouseButton(
                if (button.pressed) .down else .up,
                button.button,
            )),
            .scroll => |scroll_event| self.sendPacket(&input_packets.scroll(
                scroll_event.delta_x,
                scroll_event.delta_y,
                scroll_event.control_key,
            )),
            .key => |key| self.sendPacket(&input_packets.key(
                if (key.pressed) .down else .up,
                key.keysym,
            )),
            .paste => |text| self.sendPaste(text),
        };
    }

    fn sendCompensatingRelease(self: *Session, change: input_event.StateChange) void {
        switch (change) {
            .button => |button| {
                const packet = input_packets.mouseButton(.up, button.button);
                _ = self.sendPacket(&packet);
            },
            .key => |key| _ = self.sendKey(.up, key.keysym),
        }
    }

    fn sendPacket(self: *Session, bytes: []const u8) bool {
        const sent = if (self.packet_sink) |sink|
            sink(self.packet_sink_context, bytes)
        else if (builtin.is_test)
            false
        else
            native.kl_native_send_data(self.native_handle, bytes.ptr, bytes.len);
        if (sent) {
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
        self.admission_mutex.lock();
        self.cancelInputLocked(monotonicNowNs());
        const held = self.takeHeldInputLocked();
        self.admission_mutex.unlock();
        self.sendHeldInputReleases(held);
    }

    fn takeHeldInputLocked(self: *Session) HeldInput {
        var held: HeldInput = .{};
        held.key_count = self.held_input.key_count;
        @memcpy(held.keys[0..held.key_count], self.held_input.keys[0..held.key_count]);
        held.buttons = self.held_input.buttons;
        self.held_input.clear();
        self.physical_keys.clear();
        return held;
    }

    fn sendHeldInputReleases(self: *Session, held: HeldInput) void {
        if (self.data_open.load(.acquire) == 0) return;
        for (held.keys[0..held.key_count]) |keysym_value| _ = self.sendKey(.up, keysym_value);
        for (0..8) |button| {
            if ((held.buttons & (@as(u8, 1) << @intCast(button))) == 0) continue;
            const packet = input_packets.mouseButton(.up, @intCast(button));
            _ = self.sendPacket(&packet);
        }
    }

    fn sendPasteShortcut(self: *Session) void {
        var transitions: [4]KeyTransition = undefined;
        var transition_count: usize = 0;
        self.admission_mutex.lock();
        const now_ns = monotonicNowNs();
        const admission = self.inputRouteLocked(now_ns);
        if (admission.route == .reject) {
            self.admission_mutex.unlock();
            return;
        }
        const control_l: u64 = 0xffe3;
        const v: u64 = 'v';
        const desired = self.desiredInputLocked() catch {
            self.admission_mutex.unlock();
            if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
            return;
        };
        const control_was_held = desired.isKeyHeld(control_l);
        const v_was_held = desired.isKeyHeld(v);
        if (!control_was_held) {
            transitions[transition_count] = .{ .keysym = control_l, .pressed = true };
            transition_count += 1;
        }
        if (!v_was_held) {
            transitions[transition_count] = .{ .keysym = v, .pressed = true };
            transition_count += 1;
            transitions[transition_count] = .{ .keysym = v, .pressed = false };
            transition_count += 1;
        }
        if (!control_was_held) {
            transitions[transition_count] = .{ .keysym = control_l, .pressed = false };
            transition_count += 1;
        }
        const should_drain = self.enqueueKeyBatchLocked(
            transitions[0..transition_count],
            admission.route,
            now_ns,
        );
        self.admission_mutex.unlock();
        if (admission.request_control) _ = self.sendClaimedControlRequest(now_ns);
        if (should_drain) _ = self.drainInputQueue(null);
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

fn onFrameMetadata(context: ?*anyopaque, width: u32, height: u32) callconv(.c) void {
    const self = fromContext(context);
    _ = self.decoded_frames.fetchAdd(1, .monotonic);
    self.remote_width.store(width, .release);
    self.remote_height.store(height, .release);
}

fn noteFrameSample(self: *Session) void {
    _ = self.headless_samples.fetchAdd(1, .monotonic);
}

fn onPasteReady(context: ?*anyopaque) callconv(.c) void {
    fromContext(context).sendPasteShortcut();
}

const InputRoute = enum { reject, wait, deliver };

const AdmissionMutex = struct {
    inner: std.atomic.Mutex = .unlocked,

    fn lock(self: *AdmissionMutex) void {
        while (!self.inner.tryLock()) std.atomic.spinLoopHint();
    }

    fn unlock(self: *AdmissionMutex) void {
        self.inner.unlock();
    }
};

const InputAdmission = struct {
    route: InputRoute,
    request_control: bool = false,
};

const KeyTransition = struct {
    keysym: u64,
    pressed: bool,
};

fn appendModifierTransitions(
    flags: u64,
    modifiers: anytype,
    desired: *input_state.InputState,
    transitions: []KeyTransition,
    transition_count: *usize,
) void {
    for (modifiers) |modifier| {
        const left_held = desired.isKeyHeld(modifier.left_keysym);
        const right_held = desired.isKeyHeld(modifier.right_keysym);
        if ((flags & modifier.flag) != 0) {
            if (!left_held and !right_held and (desired.pressKey(modifier.left_keysym) catch false)) {
                std.debug.assert(transition_count.* < transitions.len);
                transitions[transition_count.*] = .{ .keysym = modifier.left_keysym, .pressed = true };
                transition_count.* += 1;
            }
            continue;
        }
        if (left_held) {
            std.debug.assert(transition_count.* < transitions.len);
            transitions[transition_count.*] = .{ .keysym = modifier.left_keysym, .pressed = false };
            transition_count.* += 1;
            _ = desired.releaseKey(modifier.left_keysym);
        }
        if (right_held) {
            std.debug.assert(transition_count.* < transitions.len);
            transitions[transition_count.*] = .{ .keysym = modifier.right_keysym, .pressed = false };
            transition_count.* += 1;
            _ = desired.releaseKey(modifier.right_keysym);
        }
    }
}

const InFlightInput = struct {
    sequence: u64,
    epoch: u64,
    change: input_event.StateChange,
};

const InputSendOutcome = enum { sent, failed, skipped };

const HeldInput = struct {
    keys: [input_state.max_held_keys]u64 = [_]u64{0} ** input_state.max_held_keys,
    key_count: usize = 0,
    buttons: u8 = 0,
};

fn classifyInputRoute(read_only: bool, data_open: bool, authorized: bool, implicit_hosting: bool) InputRoute {
    if (read_only or !data_open) return .reject;
    if (authorized or implicit_hosting) return .deliver;
    return .wait;
}

fn monotonicNowNs() i128 {
    var timestamp: std.c.timespec = undefined;
    if (std.c.clock_gettime(.MONOTONIC_RAW, &timestamp) != 0) return 0;
    return @as(i128, timestamp.sec) * std.time.ns_per_s + @as(i128, timestamp.nsec);
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
    try std.testing.expect(session.input_queue.pushKey(
        std.testing.allocator,
        1,
        session.input_epoch,
        'q',
        true,
        true,
        10,
    ).accepted());

    session.admission_mutex.lock();
    session.revokeTransportState();
    session.admission_mutex.unlock();

    try std.testing.expect(!session.isDataOpen());
    try std.testing.expect(!session.isAuthorized());
    try std.testing.expect(!session.hasRemoteController());
    try std.testing.expect(!session.isControlRequested());
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
    try std.testing.expect(!session.cursorSnapshot().position_available);
}

test "implicit hosting admits the triggering input while explicit hosting queues it" {
    try std.testing.expectEqual(.reject, classifyInputRoute(true, true, false, true));
    try std.testing.expectEqual(.reject, classifyInputRoute(false, false, false, true));
    try std.testing.expectEqual(.deliver, classifyInputRoute(false, true, true, false));
    try std.testing.expectEqual(.deliver, classifyInputRoute(false, true, false, true));
    try std.testing.expectEqual(.wait, classifyInputRoute(false, true, false, false));
}

test "legacy system error clears the request latch and pending input" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{
            .version = connection.current_version,
            .label = "legacy-error-test",
            .base_url = "http://127.0.0.1",
        },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, 100);
    session.control_requested.store(1, .release);
    session.control_request_started_ns = 10;
    try std.testing.expect(session.input_queue.pushPaste(
        std.testing.allocator,
        1,
        session.input_epoch,
        "clipboard",
        true,
        10,
    ).accepted());
    try std.testing.expect(session.input_queue.pushKey(
        std.testing.allocator,
        2,
        session.input_epoch,
        'x',
        true,
        true,
        11,
    ).accepted());

    session.applyLegacyControlError();

    try std.testing.expect(!session.isControlRequested());
    try std.testing.expectEqual(@as(?i128, null), session.control_request_started_ns);
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
    var status: [256]u8 = undefined;
    const status_len = session.copyStatus(&status);
    try std.testing.expectEqualStrings("Connected · control unavailable", status[0..status_len]);
}

const PacketRecorder = struct {
    session: *Session,
    packets: [64][11]u8 = undefined,
    lengths: [64]usize = [_]usize{0} ** 64,
    count: usize = 0,
    inject_after_first: ?u64 = null,
    injected: bool = false,
    fail_opcode: ?u8 = null,
    fail_keysym: ?u64 = null,
    failures_remaining: usize = 0,
    cancel_after_packet: ?usize = null,
    append_after_cancel: ?u64 = null,
    cancelled: bool = false,
};

fn recordPacket(context: ?*anyopaque, bytes: []const u8) bool {
    const recorder: *PacketRecorder = @ptrCast(@alignCast(context.?));
    const index = recorder.count;
    std.debug.assert(index < recorder.packets.len);
    @memcpy(recorder.packets[index][0..bytes.len], bytes);
    recorder.lengths[index] = bytes.len;
    recorder.count += 1;
    if (!recorder.cancelled and recorder.cancel_after_packet == recorder.count) {
        recorder.cancelled = true;
        recorder.session.admission_mutex.lock();
        recorder.session.cancelInputLocked(monotonicNowNs());
        recorder.session.admission_mutex.unlock();
        if (recorder.append_after_cancel) |keysym_value| {
            _ = recorder.session.setKey(keysym_value, true, false);
        }
    }
    if (!recorder.injected) {
        if (recorder.inject_after_first) |keysym_value| {
            recorder.injected = true;
            _ = recorder.session.setKey(keysym_value, true, false);
        }
    }
    if (recorder.failures_remaining > 0 and recorder.fail_opcode == bytes[0]) {
        const matches_keysym = if (recorder.fail_keysym) |keysym_value|
            bytes.len == 11 and std.mem.readInt(u64, bytes[3..11], .little) == keysym_value
        else
            true;
        if (matches_keysym) {
            recorder.failures_remaining -= 1;
            return false;
        }
    }
    return true;
}

fn expectRecordedKey(recorder: *const PacketRecorder, index: usize, action: input_packets.KeyAction, keysym_value: u64) !void {
    try std.testing.expectEqual(@as(usize, 11), recorder.lengths[index]);
    try std.testing.expectEqual(
        @intFromEnum(if (action == .down) input_packets.Opcode.key_down else input_packets.Opcode.key_up),
        recorder.packets[index][0],
    );
    try std.testing.expectEqual(keysym_value, std.mem.readInt(u64, recorder.packets[index][3..11], .little));
}

test "explicit authorization replays semantic input in FIFO order" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{
            .version = connection.current_version,
            .label = "replay-test",
            .base_url = "http://127.0.0.1",
        },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    session.self_id = try std.testing.allocator.dupe(u8, "self");
    defer std.testing.allocator.free(session.self_id.?);
    var recorder: PacketRecorder = .{ .session = &session };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    try std.testing.expect(session.setKey('a', true, false));
    try std.testing.expect(session.movePointer(20, 30));
    try std.testing.expect(session.setKey('a', false, false));
    try std.testing.expect(session.isControlRequested());
    try std.testing.expectEqual(@as(usize, 3), session.input_queue.len());
    try std.testing.expectEqual(@as(usize, 0), recorder.count);

    session.applyControlHost(true, "self");

    try std.testing.expectEqual(@as(usize, 3), recorder.count);
    try expectRecordedKey(&recorder, 0, .down, 'a');
    try std.testing.expectEqual(@intFromEnum(input_packets.Opcode.move), recorder.packets[1][0]);
    try expectRecordedKey(&recorder, 2, .up, 'a');
    try std.testing.expect(session.isAuthorized());
    try std.testing.expect(!session.isControlRequested());
    try std.testing.expect(!session.input_draining);
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
}

test "implicit hosting sends the triggering input while requesting ownership" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{
            .version = connection.current_version,
            .label = "implicit-admission-test",
            .base_url = "http://127.0.0.1",
        },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: PacketRecorder = .{ .session = &session };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.implicit_hosting.store(1, .release);

    try std.testing.expect(session.setKey('i', true, false));

    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try expectRecordedKey(&recorder, 0, .down, 'i');
    try std.testing.expect(session.isControlRequested());
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
}

test "input arriving during a drain remains behind resident FIFO input" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{
            .version = connection.current_version,
            .label = "late-replay-test",
            .base_url = "http://127.0.0.1",
        },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: PacketRecorder = .{
        .session = &session,
        .inject_after_first = 'b',
    };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    session.input_draining = true;
    try std.testing.expect(session.input_queue.pushKey(std.testing.allocator, 1, session.input_epoch, 'a', true, false, 10).accepted());
    try std.testing.expect(session.input_queue.pushKey(std.testing.allocator, 2, session.input_epoch, 'a', false, false, 11).accepted());

    _ = session.drainInputQueue(null);

    try std.testing.expectEqual(@as(usize, 3), recorder.count);
    try expectRecordedKey(&recorder, 0, .down, 'a');
    try expectRecordedKey(&recorder, 1, .up, 'a');
    try expectRecordedKey(&recorder, 2, .down, 'b');
    try std.testing.expect(recorder.injected);
    try std.testing.expect(!session.input_draining);
}

fn inputKindSnapshot(session: *Session, kind: input_event.Kind) input_metrics.KindMetrics {
    return session.snapshotInputMetrics().kinds[@intFromEnum(kind)];
}

test "held key state commits only after send and failed transitions can be retried" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "key-transaction-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    var recorder: PacketRecorder = .{
        .session = &session,
        .fail_opcode = @intFromEnum(input_packets.Opcode.key_down),
        .fail_keysym = 'k',
        .failures_remaining = 1,
    };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);

    try std.testing.expect(!session.setKey('k', true, false));
    try std.testing.expect(!session.held_input.isKeyHeld('k'));
    try std.testing.expect(session.setKey('k', true, false));
    try std.testing.expect(session.held_input.isKeyHeld('k'));

    recorder.fail_opcode = @intFromEnum(input_packets.Opcode.key_up);
    recorder.failures_remaining = 1;
    try std.testing.expect(!session.setKey('k', false, false));
    try std.testing.expect(session.held_input.isKeyHeld('k'));
    try std.testing.expect(session.setKey('k', false, false));
    try std.testing.expect(!session.held_input.isKeyHeld('k'));

    const metrics = inputKindSnapshot(&session, .key);
    try std.testing.expectEqual(@as(u64, 4), metrics.attempted);
    try std.testing.expectEqual(@as(u64, 2), metrics.sent);
    try std.testing.expectEqual(@as(u64, 2), metrics.send_failed);
}

test "held pointer button state commits only after send" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "button-transaction-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    var recorder: PacketRecorder = .{
        .session = &session,
        .fail_opcode = @intFromEnum(input_packets.Opcode.key_down),
        .fail_keysym = 1,
        .failures_remaining = 1,
    };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);

    try std.testing.expect(!session.setPointerButton(0, true));
    try std.testing.expect(!session.held_input.isButtonHeld(0));
    try std.testing.expect(session.setPointerButton(0, true));
    try std.testing.expect(session.held_input.isButtonHeld(0));
    try std.testing.expect(session.setPointerButton(0, false));
    try std.testing.expect(!session.held_input.isButtonHeld(0));
}

test "repeat downs are duplicate-suppressed before the native channel" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "repeat-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: PacketRecorder = .{ .session = &session };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);

    try std.testing.expect(session.setKey('r', true, false));
    try std.testing.expect(!session.setKey('r', true, true));
    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try std.testing.expect(session.setKey('r', false, false));
    const metrics = inputKindSnapshot(&session, .key);
    try std.testing.expectEqual(@as(u64, 1), metrics.duplicate_suppressed);
}

test "failed queued down suppresses its now-unneeded queued up" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "failure-recovery-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    var recorder: PacketRecorder = .{
        .session = &session,
        .fail_opcode = @intFromEnum(input_packets.Opcode.key_down),
        .fail_keysym = 'f',
        .failures_remaining = 1,
    };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    session.input_draining = true;
    try std.testing.expect(session.setKey('f', true, false));
    try std.testing.expect(session.setKey('f', false, false));
    session.input_draining = false;
    session.admission_mutex.lock();
    const claimed = session.claimInputDrainerLocked();
    session.admission_mutex.unlock();
    try std.testing.expect(claimed);
    _ = session.drainInputQueue(null);

    try std.testing.expectEqual(@as(usize, 1), recorder.count);
    try std.testing.expect(!session.held_input.isKeyHeld('f'));
    const metrics = inputKindSnapshot(&session, .key);
    try std.testing.expectEqual(@as(u64, 1), metrics.send_failed);
    try std.testing.expectEqual(@as(u64, 1), metrics.duplicate_suppressed);
}

test "epoch cancellation compensates a stale down and continues with new input" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "epoch-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    var recorder: PacketRecorder = .{
        .session = &session,
        .cancel_after_packet = 1,
        .append_after_cancel = 'b',
    };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);

    try std.testing.expect(!session.setKey('a', true, false));

    try std.testing.expectEqual(@as(usize, 3), recorder.count);
    try expectRecordedKey(&recorder, 0, .down, 'a');
    try expectRecordedKey(&recorder, 1, .up, 'a');
    try expectRecordedKey(&recorder, 2, .down, 'b');
    try std.testing.expect(!session.held_input.isKeyHeld('a'));
    try std.testing.expect(session.held_input.isKeyHeld('b'));
    try std.testing.expect(!session.input_draining);
    const metrics = inputKindSnapshot(&session, .key);
    try std.testing.expectEqual(@as(u64, 1), metrics.control_dropped);
}

test "explicit queue overflow attributes every abandoned event by kind" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "overflow-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    session.data_open.store(1, .release);

    for (0..pending_input.max_waiting_events) |index| {
        try std.testing.expect(session.scroll(@intCast(index), 0, index % 2 != 0));
    }
    try std.testing.expect(!session.setKey('z', true, false));
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
    const scroll_metrics = inputKindSnapshot(&session, .scroll);
    const key_metrics = inputKindSnapshot(&session, .key);
    try std.testing.expectEqual(@as(u64, pending_input.max_waiting_events), scroll_metrics.queued);
    try std.testing.expectEqual(@as(u64, pending_input.max_waiting_events), scroll_metrics.control_dropped);
    try std.testing.expectEqual(@as(u64, 1), key_metrics.control_dropped);
}

const PasteCanceller = struct {
    session: *Session,
    called: bool = false,
};

fn cancelDuringPaste(context: ?*anyopaque, text: []const u8) bool {
    const canceller: *PasteCanceller = @ptrCast(@alignCast(context.?));
    std.debug.assert(std.mem.eql(u8, text, "clipboard"));
    canceller.called = true;
    canceller.session.admission_mutex.lock();
    canceller.session.cancelInputLocked(monotonicNowNs());
    canceller.session.admission_mutex.unlock();
    return true;
}

test "cancel during paste send leaves its popped allocation owned by the drainer" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "paste-cancel-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    defer _ = session.input_queue.clear(std.testing.allocator, monotonicNowNs());
    var canceller: PasteCanceller = .{ .session = &session };
    session.paste_sink_context = &canceller;
    session.paste_sink = cancelDuringPaste;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);

    try std.testing.expect(!session.paste("clipboard"));
    try std.testing.expect(canceller.called);
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
    const metrics = inputKindSnapshot(&session, .paste);
    try std.testing.expectEqual(@as(u64, 1), metrics.sent);
    try std.testing.expectEqual(@as(u64, 1), metrics.control_dropped);
}

test "modifier synchronization drains to the same desired and held state" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "modifier-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    defer session.cursor.deinit(std.testing.allocator);
    var recorder: PacketRecorder = .{ .session = &session };
    session.packet_sink_context = &recorder;
    session.packet_sink = recordPacket;
    session.data_open.store(1, .release);
    session.authorized.store(1, .release);
    const modifiers = [_]struct { flag: u64, left_keysym: u64, right_keysym: u64 }{
        .{ .flag = 1, .left_keysym = 0xffe1, .right_keysym = 0xffe2 },
    };

    session.syncModifiers(1, modifiers);
    try std.testing.expect(session.held_input.isKeyHeld(0xffe1));
    session.syncModifiers(0, modifiers);
    try std.testing.expect(!session.held_input.isKeyHeld(0xffe1));
    session.admission_mutex.lock();
    const desired = try session.desiredInputLocked();
    session.admission_mutex.unlock();
    try std.testing.expectEqual(session.held_input.key_count, desired.key_count);
    try std.testing.expectEqual(session.held_input.buttons, desired.buttons);
    try std.testing.expectEqual(@as(usize, 0), session.input_queue.len());
}

test "held-input release clears remembered physical key targets" {
    var session: Session = .{
        .allocator = std.testing.allocator,
        .descriptor = .{ .version = connection.current_version, .label = "shortcut-release-test", .base_url = "http://127.0.0.1" },
        .native_handle = @ptrFromInt(1),
    };
    try std.testing.expect(session.physical_keys.remember(.{
        .physical_id = 8,
        .keysym = 'C',
        .removed_modifiers = 1 << 20,
        .forced_modifiers = (1 << 18) | (1 << 17),
    }));
    try std.testing.expect(session.physical_keys.hasActive());

    session.releaseHeldInput();

    try std.testing.expect(!session.physical_keys.hasActive());
    try std.testing.expect(session.physical_keys.get(8) == null);
}
