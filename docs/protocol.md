# Observed local protocol

The compatibility target is Kernel's customized Neko client at
`kernel/kernel-images` commit
`57858c774681c646c238043d5cb75a9ff61797c6`. The local observation below was
reconfirmed against a runtime-only remote browser container on 2026-08-26. Values
that identify a session, authenticate a peer, or fingerprint DTLS are omitted.

The native client opens `ws://127.0.0.1:<slot>/ws` through the SSH tunnel with
the descriptor username/password encoded as query items. The Kernel proxy
adapts the current Neko protocol to the legacy event contract used by its web
client. The useful order is:

1. WebSocket opens and system/member/control initialization arrives.
2. `signal/provide` supplies the remote offer and ICE configuration.
3. The client creates its peer and outbound `data` channel, applies the offer,
   and sends `signal/answer` plus trickled `signal/candidate` events.
4. ICE connects directly to the browser host's configured network address and per-target UDP mux
   port; DTLS/SRTP and SCTP become ready.
5. A VP8 video track and Opus audio track arrive. Version 1 renders video and
   deliberately does not play audio.
6. Both peers open a channel labeled `data`. Binary input must be sent on the
   client-created outbound channel; the server-opened inbound channel is a
   separate SCTP stream despite the identical label.
7. `control/locked` identifies the current controller. Input is locally gated
   until it identifies this connection; `client/heartbeat` is sent at the
   interval in `system/init`.

Sanitized negotiated lines:

```text
m=video 9 UDP/TLS/RTP/SAVPF 96
a=rtpmap:96 VP8/90000
m=audio 9 UDP/TLS/RTP/SAVPF 111
a=rtpmap:111 opus/48000/2
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
a=sctp-port:5000
candidate:<redacted> 1 udp <priority> <browser-host-address> <slot-udp-port> typ host
```

The binary input packet layouts and golden bytes live in
`src/protocol/input_packets.zig`. They match Kernel's
`client/src/neko/base.ts`: little-endian move, wheel, key-down, and key-up
packets with X keysyms.
