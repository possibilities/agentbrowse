/**
 * The native Live View ABI range every JavaScript consumer accepts.
 *
 * The session wrapper and the frame-conversion Worker open the same dylib from
 * different threads and used to carry their own copies of this range. They
 * drifted: an additive ABI bump moved one and not the other, and the Worker
 * answered `initialize` with an infrastructure error, which the pool records
 * permanently and answers by running every conversion synchronously on the
 * event loop — the exact regression the Worker exists to prevent, and silent
 * apart from a changed `mode` field. Both import this instead.
 *
 * MAX_ABI_VERSION tracks `abi_version` in `src/live_view_abi.zig` and
 * `AB_LIVE_VIEW_ABI_VERSION` in `include/agentbrowse_live_view.h`; a test pins
 * all three together. Raise MIN_ABI_VERSION only to drop support for a library
 * older than the oldest symbol set these consumers still open.
 */
export const MIN_ABI_VERSION = 2;
export const MAX_ABI_VERSION = 4;
