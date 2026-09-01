pub const Session = opaque {};

pub const State = enum(c_int) {
    ws_open = 1,
    ws_closed = 2,
    peer_connecting = 3,
    peer_connected = 4,
    peer_disconnected = 5,
    peer_failed = 6,
    data_open = 7,
    data_closed = 8,
    reconnect_ready = 9,
};

pub const Callbacks = extern struct {
    context: ?*anyopaque,
    on_websocket_message: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,
    on_data_message: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,
    on_local_description: ?*const fn (?*anyopaque, bool, [*]const u8, usize) callconv(.c) void,
    on_local_candidate: ?*const fn (?*anyopaque, [*]const u8, usize, [*]const u8, usize, i32) callconv(.c) void,
    on_state: ?*const fn (?*anyopaque, State) callconv(.c) void,
    on_error: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,
    on_frame: ?*const fn (?*anyopaque, u32, u32, u16, i64, [*]const u8, u32, [*]const u8, u32, [*]const u8, u32) callconv(.c) void,
    on_frame_metadata: ?*const fn (?*anyopaque, u32, u32) callconv(.c) void,
    on_paste_ready: ?*const fn (?*anyopaque) callconv(.c) void,
};

pub const AppKitCallbacks = extern struct {
    context: ?*anyopaque,
    on_pointer: ?*const fn (?*anyopaque, f64, f64, f64, f64, u8, u8, f64, f64, bool) callconv(.c) void,
    on_key: ?*const fn (?*anyopaque, u16, u64, bool, bool, [*]const u8, usize) callconv(.c) void,
    on_paste: ?*const fn (?*anyopaque, [*]const u8, usize) callconv(.c) void,
    on_focus: ?*const fn (?*anyopaque, bool) callconv(.c) void,
    on_close: ?*const fn (?*anyopaque) callconv(.c) void,
    copy_status: ?*const fn (?*anyopaque, [*]u8, u32) callconv(.c) u32,
    copy_cursor_snapshot: ?*const fn (?*anyopaque, *AppKitCursorSnapshot, u32) callconv(.c) bool,
    copy_cursor_image: ?*const fn (?*anyopaque, u64, [*]u8, u32) callconv(.c) u32,
    copy_clipboard_snapshot: ?*const fn (?*anyopaque, *AppKitClipboardSnapshot, u32) callconv(.c) bool,
    copy_clipboard_text: ?*const fn (?*anyopaque, u64, [*]u8, u32) callconv(.c) u32,
};

pub const AppKitCursorSnapshot = extern struct {
    struct_size: u32,
    flags: u32,
    width: u32,
    height: u32,
    hotspot_x: u32,
    hotspot_y: u32,
    position_x: u32,
    position_y: u32,
    image_byte_length: u32,
    reserved: u32,
    generation: u64,
    image_generation: u64,
    position_generation: u64,
};

pub const AppKitClipboardSnapshot = extern struct {
    struct_size: u32,
    flags: u32,
    text_byte_length: u32,
    reserved: u32,
    generation: u64,
};

pub extern fn kl_native_create(Callbacks) ?*Session;
pub extern fn kl_native_attach_appkit(*Session, AppKitCallbacks, [*]const u8, usize) bool;
pub extern fn kl_native_connect(*Session, [*]const u8, usize, [*]const u8, usize, [*]const u8, usize) void;
pub extern fn kl_native_create_peer(*Session, [*]const u8, usize, bool) void;
pub extern fn kl_native_set_remote_description(*Session, bool, [*]const u8, usize) void;
pub extern fn kl_native_add_ice_candidate(*Session, [*]const u8, usize) void;
pub extern fn kl_native_send_websocket(*Session, [*]const u8, usize) bool;
pub extern fn kl_native_send_data(*Session, [*]const u8, usize) bool;
pub extern fn kl_native_start_heartbeat(*Session, u32) void;
pub extern fn kl_native_schedule_paste(*Session, u32) void;
pub extern fn kl_native_schedule_reconnect(*Session, u32) void;
pub extern fn kl_native_run_appkit(*Session) c_int;
pub extern fn kl_native_close(*Session) void;
pub extern fn kl_native_destroy(*Session) void;
