#ifndef KERNEL_LIVE_VIEW_NATIVE_H
#define KERNEL_LIVE_VIEW_NATIVE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct KLNativeSessionHandle KLNativeSessionHandle;

typedef enum KLAppKitCursorFlags {
  KL_APPKIT_CURSOR_IMAGE_AVAILABLE = 1u << 0,
  KL_APPKIT_CURSOR_POSITION_AVAILABLE = 1u << 1,
  KL_APPKIT_CURSOR_AUTHORIZED = 1u << 2,
  KL_APPKIT_CURSOR_REMOTE_CONTROLLER = 1u << 3,
} KLAppKitCursorFlags;

typedef struct KLAppKitCursorSnapshot {
  uint32_t struct_size;
  uint32_t flags;
  uint32_t width;
  uint32_t height;
  uint32_t hotspot_x;
  uint32_t hotspot_y;
  uint32_t position_x;
  uint32_t position_y;
  uint32_t image_byte_length;
  uint32_t reserved;
  uint64_t generation;
  uint64_t image_generation;
  uint64_t position_generation;
} KLAppKitCursorSnapshot;

typedef enum KLNativeState {
  KL_NATIVE_WS_OPEN = 1,
  KL_NATIVE_WS_CLOSED = 2,
  KL_NATIVE_PEER_CONNECTING = 3,
  KL_NATIVE_PEER_CONNECTED = 4,
  KL_NATIVE_PEER_DISCONNECTED = 5,
  KL_NATIVE_PEER_FAILED = 6,
  KL_NATIVE_DATA_OPEN = 7,
  KL_NATIVE_DATA_CLOSED = 8,
  KL_NATIVE_RECONNECT_READY = 9,
} KLNativeState;

// Transport callbacks may run on NSURLSession or WebRTC worker threads.
typedef struct KLNativeCallbacks {
  void *context;
  void (*on_websocket_message)(void *context, const uint8_t *bytes, size_t len);
  void (*on_data_message)(void *context, const uint8_t *bytes, size_t len);
  void (*on_local_description)(void *context, bool answer, const uint8_t *bytes,
                               size_t len);
  void (*on_local_candidate)(void *context, const uint8_t *sdp, size_t sdp_len,
                             const uint8_t *mid, size_t mid_len,
                             int32_t mline_index);
  void (*on_state)(void *context, KLNativeState state);
  void (*on_error)(void *context, const uint8_t *bytes, size_t len);
  void (*on_frame)(void *context, uint32_t width, uint32_t height,
                   uint16_t rotation, int64_t timestamp_us,
                   const uint8_t *plane_y, uint32_t stride_y,
                   const uint8_t *plane_u, uint32_t stride_u,
                   const uint8_t *plane_v, uint32_t stride_v);
  void (*on_paste_ready)(void *context);
} KLNativeCallbacks;

// AppKit callbacks are installed only by the AppKit frontend adapter.
typedef struct KLAppKitCallbacks {
  void *context;
  void (*on_pointer)(void *context, double x, double y, double view_width,
                     double view_height, uint8_t kind, uint8_t button,
                     double delta_x, double delta_y, bool control_key);
  void (*on_key)(void *context, uint16_t key_code, uint64_t modifiers,
                 bool pressed, bool repeat, const uint8_t *characters,
                 size_t characters_len);
  void (*on_paste)(void *context, const uint8_t *bytes, size_t len);
  void (*on_focus)(void *context, bool focused);
  void (*on_close)(void *context);
  uint32_t (*copy_status)(void *context, uint8_t *output,
                          uint32_t output_capacity);
  bool (*copy_cursor_snapshot)(void *context,
                               KLAppKitCursorSnapshot *output,
                               uint32_t output_size);
  uint32_t (*copy_cursor_image)(void *context, uint64_t image_generation,
                                uint8_t *output, uint32_t output_capacity);
} KLAppKitCallbacks;

KLNativeSessionHandle *kl_native_create(KLNativeCallbacks callbacks);
bool kl_native_attach_appkit(KLNativeSessionHandle *session,
                             KLAppKitCallbacks callbacks,
                             const uint8_t *window_title,
                             size_t window_title_len);
void kl_native_connect(KLNativeSessionHandle *session, const uint8_t *base_url,
                       size_t base_url_len, const uint8_t *username,
                       size_t username_len, const uint8_t *password,
                       size_t password_len);
void kl_native_create_peer(KLNativeSessionHandle *session,
                           const uint8_t *ice_json, size_t ice_json_len,
                           bool lite);
void kl_native_set_remote_description(KLNativeSessionHandle *session,
                                      bool answer, const uint8_t *sdp,
                                      size_t sdp_len);
void kl_native_add_ice_candidate(KLNativeSessionHandle *session,
                                 const uint8_t *candidate_json,
                                 size_t candidate_json_len);
bool kl_native_send_websocket(KLNativeSessionHandle *session,
                              const uint8_t *bytes, size_t len);
bool kl_native_send_data(KLNativeSessionHandle *session, const uint8_t *bytes,
                         size_t len);
void kl_native_start_heartbeat(KLNativeSessionHandle *session,
                               uint32_t interval_ms);
void kl_native_schedule_paste(KLNativeSessionHandle *session,
                              uint32_t delay_ms);
void kl_native_schedule_reconnect(KLNativeSessionHandle *session,
                                  uint32_t delay_ms);
int kl_native_run_appkit(KLNativeSessionHandle *session);
void kl_native_close(KLNativeSessionHandle *session);
void kl_native_destroy(KLNativeSessionHandle *session);

#ifdef __cplusplus
}
#endif

#endif
