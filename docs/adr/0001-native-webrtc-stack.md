# 0001: Use a pinned libwebrtc XCFramework behind a C ABI

Version 1 uses LiveKitWebRTC `144.7559.14` through a thin Objective-C++ C ABI
bridge because it supplies macOS arm64 ICE, DTLS/SRTP, data channels, VP8
decode, decoded `RTCVideoFrame` callbacks, and native Metal rendering in one
pinned artifact. The release asset is 66,609,446 bytes and its Swift package
checksum is `4b0a4be4564aa05168a02f262bbbc4d6d9a552aaa1c102229ed5adf1c480b81a`.

GStreamer `webrtcbin` remains the fallback but carries a much larger runtime and
packaging surface. Libdatachannel is rejected for version 1 because its clean
transport API would still leave RTP depacketization and VP8 decoding in the
application. Adoption is conditional on the spike proving Kernel/Neko
signaling, raw decoded-frame delivery, teardown, artifact provenance, and all
bundled license obligations.
