const std = @import("std");
const pending_input = @import("pending_input.zig");

/// Neko sends the whole guest selection, so the retained observation needs its
/// own bound. It matches `pending_input.max_paste_bytes` so neither direction
/// of the clipboard can carry what the other would refuse.
pub const max_text_bytes = 1024 * 1024;

/// One guard per paste the input queue can hold while waiting for control: the
/// drainer sends that whole batch back to back, so every one of those writes is
/// outstanding before the first echo can return. Moving the queue's bound moves
/// this with it.
pub const max_outstanding_writes = pending_input.max_waiting_events;

/// Liveness backstop, and deliberately not the mechanism that stops a stale
/// guard from swallowing a real copy — retiring guards at the events that make
/// an echo impossible does that. Its only job is to guarantee the set has room,
/// so an overflow can refuse a new guard instead of evicting a live one. It is
/// therefore sized to never fire on a legitimate write still in flight: a
/// `clipboard/set` carrying the full 1 MiB `max_paste_bytes` has to upload,
/// apply in the guest, and echo back, which on a 1 Mbps uplink is about eight
/// seconds.
pub const max_echo_age_ns = 60 * std.time.ns_per_s;

pub const Snapshot = struct {
    generation: u64 = 0,
    text_available: bool = false,
    text_length: u32 = 0,
};

/// One outstanding local write, held as a length and a seeded digest rather
/// than the text. Pasting a credential into the guest is a core use of a remote
/// browser, and the plaintext of every such paste would otherwise sit in the
/// session heap for the guard's lifetime — a stronger exposure than the logging
/// this module already refuses. A digest identifies the echo just as well and
/// cannot reconstruct the secret. The seed is per session so a partial
/// disclosure (a crash dump, a serialized struct) does not hand someone an
/// offline dictionary attack against a short password.
const OutstandingWrite = struct {
    len: usize,
    digest: u64,
    expires_at_ns: i128,
};

/// The bounded latest-value guest clipboard text retained by a Live View
/// session. Frontend adapters decide whether and how to present it; it is not
/// itself a local clipboard write.
pub const State = struct {
    mutex: std.atomic.Mutex = .unlocked,
    seed: u64 = 0,
    generation: u64 = 0,
    text: ?[]u8 = null,
    echoes: [max_outstanding_writes]OutstandingWrite = undefined,
    echo_count: usize = 0,

    /// Retain one `clipboard/updated` observation. Returns false when the text
    /// is the echo of one of this session's own `clipboard/set` writes, or is
    /// too large to retain, so neither publishes a new generation.
    pub fn observe(
        self: *State,
        allocator: std.mem.Allocator,
        text: []const u8,
        now_ns: i128,
    ) !bool {
        // Hash outside the lock: the critical section stays integer compares.
        const digest = self.digestOf(text);
        // An oversized echo still has to retire its guard. A guest that
        // rewrites line endings on paste can hand back more bytes than it was
        // given, so the echo of a near-cap paste can exceed what is retainable
        // while its guard is still outstanding.
        const oversized = text.len > max_text_bytes;
        const copy = if (oversized) null else try allocator.dupe(u8, text);
        lock(&self.mutex);
        self.dropExpiredLocked(now_ns);
        const matched = self.takeEchoLocked(text.len, digest);
        if (matched or oversized) {
            self.mutex.unlock();
            if (copy) |bytes| allocator.free(bytes);
            return false;
        }
        const old = self.text;
        self.text = copy;
        bump(&self.generation);
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
        return true;
    }

    /// Remember text this session is about to write to the guest clipboard so
    /// its reflection does not overwrite the local clipboard. Infallible: a
    /// guard that could fail to arm would silently let its own echo through.
    pub fn noteLocalWrite(self: *State, text: []const u8, now_ns: i128) void {
        const digest = self.digestOf(text);
        lock(&self.mutex);
        defer self.mutex.unlock();
        self.dropExpiredLocked(now_ns);
        // Refuse rather than evict. Evicting the oldest would drop the guard
        // whose echo is next to arrive, and that echo then republishes an
        // earlier paste — settling the local clipboard on stale text, which is
        // the exact harm these guards exist to prevent. Refusing settles it on
        // the most recent paste instead, which is where the text came from.
        if (self.echo_count == max_outstanding_writes) return;
        self.echoes[self.echo_count] = .{
            .len = text.len,
            .digest = digest,
            .expires_at_ns = now_ns + max_echo_age_ns,
        };
        self.echo_count += 1;
    }

    /// Retire the guard for a write that cannot be echoed because it never
    /// reached the guest.
    pub fn retireLocalWrite(self: *State, text: []const u8) void {
        const digest = self.digestOf(text);
        lock(&self.mutex);
        defer self.mutex.unlock();
        _ = self.takeEchoLocked(text.len, digest);
    }

    /// Drop every outstanding guard while keeping the retained observation.
    /// Neko routes `clipboard/updated` to the control host alone, so losing
    /// control makes every guard unanswerable; leaving them armed would swallow
    /// a genuine later copy of that text.
    pub fn clearOutstandingWrites(self: *State) void {
        lock(&self.mutex);
        defer self.mutex.unlock();
        self.echo_count = 0;
    }

    pub fn snapshot(self: *State) Snapshot {
        lock(&self.mutex);
        defer self.mutex.unlock();
        return .{
            .generation = self.generation,
            .text_available = self.text != null,
            .text_length = if (self.text) |bytes| @intCast(bytes.len) else 0,
        };
    }

    pub fn copyText(self: *State, generation: u64, output: []u8) usize {
        lock(&self.mutex);
        defer self.mutex.unlock();
        const text = self.text orelse return 0;
        if (generation != self.generation or output.len < text.len) return 0;
        @memcpy(output[0..text.len], text);
        return text.len;
    }

    /// Drop the retained guest text and every outstanding guard on transport
    /// loss. A reconnect observes the guest clipboard afresh rather than
    /// presenting text from a dead peer or guarding against its reflections.
    pub fn reset(self: *State, allocator: std.mem.Allocator) void {
        lock(&self.mutex);
        const old_text = self.text;
        self.text = null;
        self.echo_count = 0;
        if (old_text != null) bump(&self.generation);
        self.mutex.unlock();
        if (old_text) |bytes| allocator.free(bytes);
    }

    pub fn deinit(self: *State, allocator: std.mem.Allocator) void {
        self.reset(allocator);
    }

    fn digestOf(self: *State, text: []const u8) u64 {
        return std.hash.Wyhash.hash(self.seed, text);
    }

    fn dropExpiredLocked(self: *State, now_ns: i128) void {
        var kept: usize = 0;
        for (self.echoes[0..self.echo_count]) |entry| {
            if (now_ns >= entry.expires_at_ns) continue;
            self.echoes[kept] = entry;
            kept += 1;
        }
        self.echo_count = kept;
    }

    fn takeEchoLocked(self: *State, len: usize, digest: u64) bool {
        for (self.echoes[0..self.echo_count], 0..) |entry, index| {
            if (entry.len != len or entry.digest != digest) continue;
            // Retiring the match means a later genuine copy of the same text
            // still reaches the adapters.
            std.mem.copyForwards(
                OutstandingWrite,
                self.echoes[index .. self.echo_count - 1],
                self.echoes[index + 1 .. self.echo_count],
            );
            self.echo_count -= 1;
            return true;
        }
        return false;
    }
};

/// A per-session digest seed drawn from the OS CSPRNG. Without it, a 64-bit
/// hash of a short or common password is dictionary-attackable offline by
/// anyone who obtains a digest. It does not defend against a full memory dump —
/// the seed is in the same memory — but it does defend against the realistic
/// case of partial disclosure.
pub fn randomSeed() u64 {
    var seed: u64 = undefined;
    std.c.arc4random_buf(@ptrCast(&seed), @sizeOf(u64));
    return seed;
}

fn bump(value: *u64) void {
    value.* +%= 1;
    if (value.* == 0) value.* = 1;
}

fn lock(mutex: *std.atomic.Mutex) void {
    while (!mutex.tryLock()) std.atomic.spinLoopHint();
}

test "clipboard observation retains guest text by generation" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    try std.testing.expect(!state.snapshot().text_available);
    try std.testing.expect(try state.observe(std.testing.allocator, "guest selection", 0));

    const current = state.snapshot();
    try std.testing.expect(current.text_available);
    try std.testing.expectEqual(@as(u32, "guest selection".len), current.text_length);

    var copied: ["guest selection".len]u8 = undefined;
    try std.testing.expectEqual(copied.len, state.copyText(current.generation, &copied));
    try std.testing.expectEqualSlices(u8, "guest selection", &copied);
    // A stale generation reads nothing, so an adapter cannot present text that
    // a newer observation already replaced.
    try std.testing.expectEqual(@as(usize, 0), state.copyText(current.generation - 1, &copied));
}

test "clipboard observation refuses the reflection of one local write" {
    var state: State = .{ .seed = 0x9e3779b97f4a7c15 };
    defer state.deinit(std.testing.allocator);

    state.noteLocalWrite("pasted text", 0);
    try std.testing.expect(!try state.observe(std.testing.allocator, "pasted text", 1));
    try std.testing.expectEqual(@as(u64, 0), state.snapshot().generation);

    // The guard is spent, so copying that same text in the guest still lands.
    try std.testing.expect(try state.observe(std.testing.allocator, "pasted text", 2));
    try std.testing.expect(state.snapshot().text_available);
}

test "several outstanding writes each guard their own reflection" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    // Pastes queued behind control admission drain back to back, so both writes
    // leave before either reflection returns.
    state.noteLocalWrite("first", 0);
    state.noteLocalWrite("second", 0);

    // The earlier reflection must not publish as a fresh observation, which
    // would overwrite the local clipboard with the text already moved on from.
    try std.testing.expect(!try state.observe(std.testing.allocator, "first", 1));
    try std.testing.expect(!try state.observe(std.testing.allocator, "second", 1));
    try std.testing.expectEqual(@as(u64, 0), state.snapshot().generation);
    try std.testing.expect(!state.snapshot().text_available);
}

test "a write that never reached the guest retires its own guard" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    // A failed `clipboard/set` send can never be echoed, so leaving its guard
    // armed would swallow a genuine later copy of that text.
    state.noteLocalWrite("hunter2", 0);
    state.retireLocalWrite("hunter2");
    try std.testing.expect(try state.observe(std.testing.allocator, "hunter2", 1));
    try std.testing.expect(state.snapshot().text_available);
}

test "losing control drops every guard but keeps the observation" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    try std.testing.expect(try state.observe(std.testing.allocator, "retained", 0));
    const observed = state.snapshot();
    state.noteLocalWrite("in flight", 0);

    // Neko routes clipboard/updated to the control host alone, so an
    // outstanding guard becomes unanswerable the moment control is lost.
    state.clearOutstandingWrites();
    try std.testing.expect(try state.observe(std.testing.allocator, "in flight", 1));
    try std.testing.expect(state.snapshot().generation > observed.generation);
}

test "an oversized echo is unretainable but still retires its guard" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    const oversized = try std.testing.allocator.alloc(u8, max_text_bytes + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');

    // A guest that rewrites line endings on paste hands back more bytes than it
    // was given, so a near-cap paste can echo above what is retainable.
    state.noteLocalWrite(oversized, 0);
    try std.testing.expect(!try state.observe(std.testing.allocator, oversized, 1));
    try std.testing.expect(!state.snapshot().text_available);

    // Its guard is gone rather than stranded for the life of the connection.
    state.noteLocalWrite("small", 1);
    try std.testing.expectEqual(@as(usize, 1), state.echo_count);
}

test "an outstanding guard expires so overflow can always refuse" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    state.noteLocalWrite("stale", 0);
    // Expiry is a liveness backstop for the overflow policy, not the mechanism
    // that retires a never-echoed write.
    state.noteLocalWrite("fresh", max_echo_age_ns);
    try std.testing.expectEqual(@as(usize, 1), state.echo_count);
}

test "an overflowing guard set refuses rather than evicting a live guard" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    var labels: [max_outstanding_writes + 1][3]u8 = undefined;
    for (&labels, 0..) |*label, index| {
        label.* = .{ 'w', @intCast('0' + index / 10), @intCast('0' + index % 10) };
        state.noteLocalWrite(label, 0);
    }
    try std.testing.expectEqual(max_outstanding_writes, state.echo_count);

    // The oldest guard is the one whose echo arrives next; evicting it would
    // republish an earlier paste and settle the local clipboard on stale text.
    try std.testing.expect(!try state.observe(std.testing.allocator, &labels[0], 1));
    // The refused write is the newest, so the clipboard settles on the text the
    // operator pasted most recently — which is where it came from.
    try std.testing.expect(try state.observe(std.testing.allocator, &labels[labels.len - 1], 1));
}

test "clipboard observation clears on reset" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    try std.testing.expect(try state.observe(std.testing.allocator, "retained", 0));
    const observed = state.snapshot();
    state.noteLocalWrite("in flight", 0);
    state.reset(std.testing.allocator);
    const cleared = state.snapshot();
    try std.testing.expect(!cleared.text_available);
    try std.testing.expect(cleared.generation > observed.generation);
    try std.testing.expectEqual(@as(usize, 0), state.echo_count);
}

test "a seeded digest still identifies an echo exactly" {
    var seeded: State = .{ .seed = 0x243f6a8885a308d3 };
    defer seeded.deinit(std.testing.allocator);

    seeded.noteLocalWrite("secret", 0);
    // Length is compared before the digest, so same-length neighbours are the
    // only ones a collision could reach at all.
    try std.testing.expect(try seeded.observe(std.testing.allocator, "sec_et", 1));
    try std.testing.expect(!try seeded.observe(std.testing.allocator, "secret", 1));
}
