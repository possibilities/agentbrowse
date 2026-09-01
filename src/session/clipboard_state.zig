const std = @import("std");

/// Neko sends the whole guest selection, so the retained observation needs its
/// own bound. It matches `pending_input.max_paste_bytes` so neither direction
/// of the clipboard can carry what the other would refuse.
pub const max_text_bytes = 1024 * 1024;

pub const Snapshot = struct {
    generation: u64 = 0,
    text_available: bool = false,
    text_length: u32 = 0,
};

/// The bounded latest-value guest clipboard text retained by a Live View
/// session. Frontend adapters decide whether and how to present it; it is not
/// itself a local clipboard write.
pub const State = struct {
    mutex: std.atomic.Mutex = .unlocked,
    generation: u64 = 0,
    text: ?[]u8 = null,
    echo: ?[]u8 = null,

    /// Retain one `clipboard/updated` observation. Returns false when the text
    /// is the echo of our own `clipboard/set` write or exceeds the bound, so
    /// neither publishes a new generation to the adapters.
    pub fn observe(self: *State, allocator: std.mem.Allocator, text: []const u8) !bool {
        if (text.len > max_text_bytes) return false;
        const copy = try allocator.dupe(u8, text);
        lock(&self.mutex);
        if (self.echo) |echo| {
            if (std.mem.eql(u8, echo, text)) {
                // Setting the guest clipboard makes xclip take the CLIPBOARD
                // selection, which reflects our own paste straight back. Retire
                // the guard so a later genuine copy of the same text still
                // reaches the adapters.
                self.echo = null;
                self.mutex.unlock();
                allocator.free(copy);
                allocator.free(echo);
                return false;
            }
        }
        const old = self.text;
        self.text = copy;
        bump(&self.generation);
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
        return true;
    }

    /// Remember the text this session is about to write to the guest clipboard
    /// so its reflection does not overwrite the local clipboard.
    pub fn noteLocalWrite(self: *State, allocator: std.mem.Allocator, text: []const u8) void {
        const copy = allocator.dupe(u8, text) catch null;
        lock(&self.mutex);
        const old = self.echo;
        self.echo = copy;
        self.mutex.unlock();
        if (old) |bytes| allocator.free(bytes);
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

    /// Drop the retained guest text on transport loss. A reconnect observes the
    /// guest clipboard afresh rather than presenting text from a dead peer.
    pub fn reset(self: *State, allocator: std.mem.Allocator) void {
        lock(&self.mutex);
        const old_text = self.text;
        const old_echo = self.echo;
        self.text = null;
        self.echo = null;
        if (old_text != null) bump(&self.generation);
        self.mutex.unlock();
        if (old_text) |bytes| allocator.free(bytes);
        if (old_echo) |bytes| allocator.free(bytes);
    }

    pub fn deinit(self: *State, allocator: std.mem.Allocator) void {
        lock(&self.mutex);
        const old_text = self.text;
        const old_echo = self.echo;
        self.text = null;
        self.echo = null;
        self.mutex.unlock();
        if (old_text) |bytes| allocator.free(bytes);
        if (old_echo) |bytes| allocator.free(bytes);
    }
};

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
    try std.testing.expect(try state.observe(std.testing.allocator, "guest selection"));

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

test "clipboard observation refuses the echo of one local write" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    state.noteLocalWrite(std.testing.allocator, "pasted text");
    try std.testing.expect(!try state.observe(std.testing.allocator, "pasted text"));
    try std.testing.expectEqual(@as(u64, 0), state.snapshot().generation);

    // The guard is spent, so copying that same text in the guest still lands.
    try std.testing.expect(try state.observe(std.testing.allocator, "pasted text"));
    try std.testing.expect(state.snapshot().text_available);
}

test "clipboard observation bounds text and clears on reset" {
    var state: State = .{};
    defer state.deinit(std.testing.allocator);

    const oversized = try std.testing.allocator.alloc(u8, max_text_bytes + 1);
    defer std.testing.allocator.free(oversized);
    @memset(oversized, 'x');
    try std.testing.expect(!try state.observe(std.testing.allocator, oversized));
    try std.testing.expect(!state.snapshot().text_available);

    try std.testing.expect(try state.observe(std.testing.allocator, "retained"));
    const observed = state.snapshot();
    state.reset(std.testing.allocator);
    const cleared = state.snapshot();
    try std.testing.expect(!cleared.text_available);
    try std.testing.expect(cleared.generation > observed.generation);
}
