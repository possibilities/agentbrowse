# Observed local protocol

The Browser target is built from `kernel/kernel-images` commit
`57858c774681c646c238043d5cb75a9ff61797c6` and runs Neko
`v3.0.8-v1.6.0` at commit `148bc06bbd11173a4e8b826f0dbebe1fef7bcb98`.
The current API contract below replaces the legacy `/ws` compatibility proxy,
which always selects Neko's cursor-composited `legacy` stream. Values that
identify a session, authenticate a peer, or fingerprint DTLS are omitted.

The useful order is:

1. The native client posts the descriptor username and password as JSON to
   `/api/login` and retains the returned token.
2. It opens `/api/ws?token=…` through the descriptor base URL—through a
   loopback SSH forward for Docker or directly at `192.168.64.x:8080` for
   Apple—and receives `system/init`.
3. It sends `signal/request` with video selector
   `{ "type": "exact", "id": "main", "bitrate": 0 }`, audio
   `{ "disabled": false }`, and `auto: false`. `main` is the pointerless
   stream.
4. `signal/provide` supplies the remote offer and frontend ICE servers. The
   client creates its peer and outbound `data` channel, applies the offer, and
   sends `signal/answer` plus trickled `signal/candidate` events.
5. ICE connects directly to the Browser host's configured network address and
   per-target UDP mux port; DTLS/SRTP and SCTP become ready.
6. A VP8 video track and Opus audio track arrive. The current clients render
   video and deliberately do not play audio.
7. `control/host` identifies whether a control host exists and its session ID.
   Input is locally gated until it identifies this connection;
   `client/heartbeat` is sent at the interval in `system/init`.

Current WebSocket messages use an `{ "event": …, "payload": … }` envelope.
Events without data may omit `payload`. Offers and answers place `sdp` in the
payload, while ICE candidate fields are the payload itself. Clipboard writes
use `clipboard/set`. The login token is reused across transport reconnects;
final close makes a best-effort `/api/logout` request bounded to 500 ms.

## Data channels and cursor packets

Both peers open a channel labeled `data`, but they are distinct SCTP streams.
Binary pointer and keyboard input is sent only on the client-created outbound
input channel. The pinned Neko runtime enables its legacy compatibility path;
after it observes that client-created channel, cursor observations can arrive
on either the server-created stream or the client-created stream. The native
bridge retains both channel objects and accepts cursor packets from both rather
than treating creator identity as directionality.

Cursor packets use a one-byte opcode and a big-endian two-byte total packet
length:

- `0x01` is exactly seven bytes: header, `x: u16`, then `y: u16`.
- `0x02` is header, `width: u16`, `height: u16`, `xhot: u16`, `yhot: u16`,
  then PNG bytes.

The client rejects malformed lengths, invalid PNG signatures, out-of-bounds
hotspots, images over 1024 pixels per dimension, and images over 1 MiB. Neko
sends cursor images to every peer but suppresses position packets for the
current control host. It has no cursor visibility or producer-stall packet;
control-host and transport transitions therefore define when retained
positions are invalidated.

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

The outbound binary input packet layouts and golden bytes live in
`src/protocol/input_packets.zig`. They match Kernel's
`client/src/neko/base.ts`: little-endian move, wheel, key-down, and key-up
packets with X keysyms.
