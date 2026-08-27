# Performance and boundedness

## AppKit baseline

The first local measurement used the 1920×1080@25 VP8 Artbird target on an
Apple-silicon Mac running macOS 26.5.2. With a mostly static Chromium page, the
native process settled near 118 MiB resident memory, 18–22% of one CPU core,
and 17 threads after more than ten minutes. These are development (`Debug`)
build figures, not release targets.

The LiveKit Metal renderer does not expose a display acknowledgement. AppKit
therefore reports decoded frames, conversion failures, queue publications,
queue replacements, and periodic frame checksums; it does not describe
submitted frames as confirmed display refreshes.

An outage test kept the tunnel down across multiple failed WebSocket attempts,
then restored it. The same window re-established signaling, WebRTC, the
client-created outbound input channel, and changing decoded frames through
bounded exponential backoff.

## OpenTUI smoke run

The first end-to-end OpenTUI run used an 80×24 terminal and a 1920×1080 I420
Browser target with both renderer and Live View polling set to 15 FPS. It
verified the blank state, Browser-target picker, managed tunnel, signaling,
WebRTC, native conversion, OpenTUI image rendering, keyboard navigation, mapped
pointer input, and clean shutdown. The last sampled native counters were 2,000
decoded frames, zero failed frames, and 1,999 queue replacements; checksums
changed after both keyboard and pointer interaction.

That replacement count is not a presentation-drop count. The queue always owns
one latest frame, so every publication after the first replaces its retained
predecessor even when a consumer currently holds a separate lease. The OpenTUI
adapter's `skippedFrames` counter is the relevant consumer-side signal: it sums
generation gaps between frames handed to `ImageRenderable`.

## Work and memory bounds

- The native pending queue retains one I420 frame. Consumers can add only the
  leases they explicitly hold; `LiveViewRenderable` holds one lease only for a
  synchronous conversion.
- Bun polls at 1–30 FPS, with 15 FPS as the default. A slow or paused event loop
  reads the newest generation when it resumes rather than draining a backlog.
- RGBA output is fitted to terminal pixel capacity before conversion and is
  limited to 8192 pixels per dimension and 32 million pixels total.
- Conversion rotates, scales, and converts in one native pass. It allocates no
  source-sized RGBA intermediate.
- `NativeImage.fromRgba` and OpenTUI retain their own native image storage, so
  one submitted generation currently incurs a caller-owned RGBA buffer plus
  OpenTUI's retained copy. The caller buffer becomes collectible immediately
  after the source assignment.
- Each decoded WebRTC frame is still copied once into an immutable I420 frame,
  even when the OpenTUI poller will skip its generation. Producer-side
  throttling is a possible optimization only after measurements show that copy
  to be the limiting cost.

`LiveViewSubmissionMetrics` exposes frames submitted as `ImageRenderable`
sources, skipped generations, RGBA bytes and byte rate, output dimensions,
native conversion last/average/max duration, and time since the most recent
submission. Terminals do not provide an acknowledgement that the pixels became
visible. Native counters separately expose decode, queue, input-mapping, and
data-channel results.

Pointer-to-visible-response latency, terminal-protocol throughput, sustained
CPU/RSS for Kitty graphics versus block fallback, and p50/p95 submission age
still need controlled benchmark runs. Until those measurements identify an
OpenTUI bottleneck, the design stays on its public `NativeImage` and
`ImageRenderable` APIs rather than carrying an OpenTUI native patch.
