#ifndef AGENTBROWSE_LIVE_VIEW_H
#define AGENTBROWSE_LIVE_VIEW_H

#include <stdint.h>

#if defined(_WIN32)
#define AB_LIVE_VIEW_API __declspec(dllexport)
#else
#define AB_LIVE_VIEW_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define AB_LIVE_VIEW_ABI_VERSION 2u

typedef struct ABLiveViewSession ABLiveViewSession;
typedef struct ABLiveViewFrameLease ABLiveViewFrameLease;

// The ABI never calls into its consumer. Native transport threads publish
// state and the latest frame internally; consumers poll from their own thread.
// Do not race session destruction with another call using that session handle.

typedef enum ABLiveViewResult {
  AB_LIVE_VIEW_OK = 0,
  AB_LIVE_VIEW_INVALID_ARGUMENT = 1,
  AB_LIVE_VIEW_CLOSED = 2,
  AB_LIVE_VIEW_BUFFER_TOO_SMALL = 3,
  AB_LIVE_VIEW_UNSUPPORTED = 4,
  AB_LIVE_VIEW_INTERNAL_ERROR = 5,
} ABLiveViewResult;

typedef enum ABLiveViewLifecycle {
  AB_LIVE_VIEW_IDLE = 0,
  AB_LIVE_VIEW_CONNECTING = 1,
  AB_LIVE_VIEW_CONNECTED = 2,
  AB_LIVE_VIEW_RECONNECTING = 3,
  AB_LIVE_VIEW_CLOSED = 4,
  AB_LIVE_VIEW_FAILED = 5,
} ABLiveViewLifecycle;

typedef enum ABLiveViewFlags {
  AB_LIVE_VIEW_DATA_OPEN = 1u << 0,
  AB_LIVE_VIEW_AUTHORIZED = 1u << 1,
  AB_LIVE_VIEW_CONTROL_REQUESTED = 1u << 2,
  AB_LIVE_VIEW_READ_ONLY = 1u << 3,
  AB_LIVE_VIEW_IS_CLOSED = 1u << 4,
} ABLiveViewFlags;

typedef enum ABLiveViewFrameFormat {
  AB_LIVE_VIEW_FRAME_I420 = 1,
} ABLiveViewFrameFormat;

typedef enum ABLiveViewCursorFlags {
  AB_LIVE_VIEW_CURSOR_IMAGE_AVAILABLE = 1u << 0,
  AB_LIVE_VIEW_CURSOR_POSITION_AVAILABLE = 1u << 1,
} ABLiveViewCursorFlags;

// Callers initialize no fields. The library writes the complete fixed-layout
// snapshot when output_size is at least sizeof(ABLiveViewSnapshot).
typedef struct ABLiveViewSnapshot {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t lifecycle;
  uint32_t flags;
  uint32_t remote_width;
  uint32_t remote_height;
  uint64_t latest_frame_generation;
} ABLiveViewSnapshot;

typedef struct ABLiveViewMetrics {
  uint32_t struct_size;
  uint32_t abi_version;
  uint64_t decoded_frames;
  uint64_t failed_frames;
  uint64_t frame_samples;
  uint64_t published_frames;
  uint64_t replaced_frames;
  uint64_t pointer_events;
  uint64_t mapped_pointer_events;
  uint64_t key_events;
  uint64_t mapped_key_events;
  uint64_t data_packets_sent;
  uint64_t data_packets_failed;
} ABLiveViewMetrics;

typedef struct ABLiveViewFrameInfo {
  uint32_t struct_size;
  uint32_t format;
  uint32_t width;
  uint32_t height;
  uint32_t display_width;
  uint32_t display_height;
  uint32_t rotation_degrees;
  uint32_t reserved;
  uint64_t generation;
  int64_t timestamp_us;
} ABLiveViewFrameInfo;

// A cursor observation is transport-derived latest-value state. Frontend
// adapters decide whether and how to present it. The image is PNG-encoded and
// bounded to 1 MiB by the session parser.
typedef struct ABLiveViewCursorSnapshot {
  uint32_t struct_size;
  uint32_t abi_version;
  uint32_t flags;
  uint32_t width;
  uint32_t height;
  uint32_t hotspot_x;
  uint32_t hotspot_y;
  uint32_t position_x;
  uint32_t position_y;
  uint32_t image_byte_length;
  uint64_t generation;
  uint64_t image_generation;
  uint64_t position_generation;
} ABLiveViewCursorSnapshot;

AB_LIVE_VIEW_API uint32_t ab_live_view_abi_version(void);

// The descriptor bytes are copied and retained until session destruction.
// Failures return NULL and write a non-secret diagnostic to error_output.
AB_LIVE_VIEW_API ABLiveViewSession *ab_live_view_session_create(
    const uint8_t *descriptor_json, uint32_t descriptor_length,
    uint8_t *error_output, uint32_t error_capacity);
AB_LIVE_VIEW_API uint32_t
ab_live_view_session_connect(ABLiveViewSession *session);
AB_LIVE_VIEW_API void ab_live_view_session_close(ABLiveViewSession *session);
// Destroy closes the session and waits for native callbacks already in flight.
// Independently acquired frame leases remain valid until explicitly released.
AB_LIVE_VIEW_API void ab_live_view_session_destroy(ABLiveViewSession *session);

AB_LIVE_VIEW_API uint32_t ab_live_view_session_snapshot(
    ABLiveViewSession *session, ABLiveViewSnapshot *output,
    uint32_t output_size);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_metrics(
    ABLiveViewSession *session, ABLiveViewMetrics *output,
    uint32_t output_size);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_copy_status(
    ABLiveViewSession *session, uint8_t *output, uint32_t output_capacity);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_cursor_snapshot(
    ABLiveViewSession *session, ABLiveViewCursorSnapshot *output,
    uint32_t output_size);
// Returns the PNG byte count copied, or zero when the requested generation is
// no longer current, no cursor image is available, or the buffer is too small.
AB_LIVE_VIEW_API uint32_t ab_live_view_session_copy_cursor_image(
    ABLiveViewSession *session, uint64_t image_generation, uint8_t *output,
    uint32_t output_capacity);

// Returns NULL when no frame newer than after_generation is available.
AB_LIVE_VIEW_API ABLiveViewFrameLease *ab_live_view_session_acquire_frame(
    ABLiveViewSession *session, uint64_t after_generation);
AB_LIVE_VIEW_API uint32_t ab_live_view_frame_info(
    ABLiveViewFrameLease *lease, ABLiveViewFrameInfo *output,
    uint32_t output_size);
AB_LIVE_VIEW_API uint32_t ab_live_view_frame_convert_rgba(
    ABLiveViewFrameLease *lease, uint32_t output_width,
    uint32_t output_height, uint8_t *output, uint32_t output_stride,
    uint64_t output_capacity);
AB_LIVE_VIEW_API void
ab_live_view_frame_release(ABLiveViewFrameLease *lease);

// Control and input calls below return 1 when the request was accepted or the
// packet was sent, and 0 otherwise. They do not return ABLiveViewResult.
AB_LIVE_VIEW_API uint32_t
ab_live_view_session_request_control(ABLiveViewSession *session);
AB_LIVE_VIEW_API uint32_t
ab_live_view_session_release_control(ABLiveViewSession *session);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_pointer_move(
    ABLiveViewSession *session, uint16_t x, uint16_t y);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_pointer_button(
    ABLiveViewSession *session, uint8_t button, uint8_t pressed);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_scroll(
    ABLiveViewSession *session, int16_t delta_x, int16_t delta_y,
    uint8_t control_key);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_key(
    ABLiveViewSession *session, uint64_t keysym, uint8_t pressed,
    uint8_t repeat);
AB_LIVE_VIEW_API uint32_t ab_live_view_session_paste(
    ABLiveViewSession *session, const uint8_t *utf8, uint32_t length);
AB_LIVE_VIEW_API void
ab_live_view_session_release_held_input(ABLiveViewSession *session);

#ifdef __cplusplus
}
#endif

#endif
