# Initial local measurements

The first local measurement used the 1920×1080@25 VP8 artbird target on an
Apple-silicon Mac running macOS 26.5.2. With a mostly static Chromium page, the
native process settled near 118 MiB resident memory, 18–22% of one CPU core,
and 17 threads after more than ten minutes. These are development (`Debug`)
build figures, not release targets.

Normal diagnostics report decoded and failed frames, latest-frame replacements,
and a checksum sampled through the frontend-neutral frame-lease API every 100
decoded frames. The pending-frame queue is structurally capped at one. The
LiveKit Metal renderer does not expose a presentation callback, so version 1
does not mislabel submitted decoded frames as confirmed display refreshes.

Pointer-to-visible-response latency and p50/p95 presentation age still require
an instrumented human-input run; they are not inferred from transport state.

An outage test kept the tunnel down across multiple failed WebSocket attempts,
then restored it. The same window re-established signaling, WebRTC, the
client-created input channel, and changing decoded frames through bounded
exponential backoff.
