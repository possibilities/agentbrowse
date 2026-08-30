# Performance and boundedness

## AppKit baseline

The first local measurement used a 1920×1080@25 VP8 remote target on an
Apple-silicon Mac running macOS 26.5.2. With a mostly static Chromium page, the
native process settled near 118 MiB resident memory, 18–22% of one CPU core,
and 17 threads after more than ten minutes. These are development (`Debug`)
build figures, not release targets.

The LiveKit Metal renderer does not expose a display acknowledgement. AppKit
therefore reports decoded-frame counts and dimensions, but does not describe
those frames as confirmed display refreshes. Conversion failures, queue
publications, queue replacements, and periodic frame checksums belong to the
headless/OpenTUI path.

An outage test kept the tunnel down across multiple failed WebSocket attempts,
then restored it. The same window re-established signaling, WebRTC, the
client-created outbound input channel, and changing decoded frames through
bounded exponential backoff.

## Capture cadence matrix

The Input-to-decoded probe compared complete 1920×1080 VP8 capture profiles on
the `artbird` Docker backend. The 25 and 60 fps rows use 60 measured trials per
case; the conservative 30 fps confirmation uses 20. All profiles use
`cpu-used=4`, four threads, a 60 Hz virtual display for the 30/60 rows, bitrate
scaled with cadence, and a one-second keyframe interval.

| Capture | Decoded cadence | Cell key / pointer p95 | Viewport key / pointer p95 |
| --- | ---: | ---: | ---: |
| 25 fps baseline | 25.2 fps | 131.4 / 132.9 ms | 142.4 / 141.8 ms |
| 30 fps shared default | 30.2 fps | 121.8 / 121.5 ms | 129.5 / 125.2 ms |
| 60 fps capable-backend profile | 60.0 fps | 84.1 / 82.6 ms | 89.4 / 93.1 ms |

The 30 fps profile is the shared default because it improves every measured
tail without assuming the backend can sustain 1080p60 encoding. The 60 fps
profile remains the measured choice for `artbird`; the local Apple backend's
two-CPU profile could not be validated while its manually managed service was
disabled. A 300-frame keyframe interval was rejected: Neko does not act on
receiver PLI/FIR, so loss can otherwise leave corruption until the next
periodic keyframe.

## OpenTUI smoke run

The first end-to-end OpenTUI run used an 80×24 terminal and a 1920×1080 I420
Browser target with both renderer and Live View polling set to 15 FPS. It
verified the blank state, Browser-target picker, managed tunnel, signaling,
WebRTC, native conversion, OpenTUI image rendering, keyboard navigation, mapped
pointer input, and clean shutdown. The last sampled native counters were 2,000
decoded frames, zero failed frames, and 1,999 queue replacements; checksums
changed after both keyboard and pointer interaction.

That run exposed a presentation bottleneck below the adapter: OpenTUI 0.5.8's
native Kitty path serialized a destructive image delete, replacement transmit,
and placement for every changed `NativeImage`. Ghostty could display the black
cell background between those operations even though decoding, conversion, and
polling remained healthy. The pinned carry build keeps image and placement IDs
stable and retransmits changed pixels without the delete. All 21 native Kitty
renderer tests passed against the 0.5.8 base. A connected agentbrowse stream
then emitted replacement transmissions with zero destructive `d=I` deletes;
ten ScreenCaptureKit samples over five seconds showed no black transition and
only 0–0.11% ordinary inter-frame pixel change.

That replacement count is not a presentation-drop count. The queue always owns
one latest frame, so every publication after the first replaces its retained
predecessor even when a consumer currently holds a separate lease. The OpenTUI
adapter's `skippedFrames` counter is the relevant consumer-side signal: it sums
generation gaps between frames handed to `ImageRenderable`.

## Native frame-conversion benchmark

`bun run native:bench:conversion` measures a ReleaseFast conversion of a
deterministically randomized 1920×1080 I420 source into common fitted output
sizes. It reuses the caller-owned output as the adapter does, hashes every
result outside the timed interval, and reports nearest-rank percentiles. On the
same Apple-silicon development Mac, 20 measured iterations before and after row
parallelism gave:

| Output | Serial mean / p95 | Four-row-partition mean / p95 |
| --- | ---: | ---: |
| 1920×1080 | 5.70 / 5.76 ms | 1.03 / 1.01 ms |
| 1728×972 | 22.64 / 22.72 ms | 2.91 / 3.13 ms |
| 1280×720 | 12.52 / 12.57 ms | 1.62 / 1.68 ms |
| 960×540 | 7.05 / 7.10 ms | 0.95 / 1.02 ms |

Conversions of at least 256K output pixels split four disjoint row ranges
between three temporary workers and the caller. Resized conversions precompute
the bounded horizontal luma/chroma samples once; every worker derives its first
vertical sample directly from its starting row. If a worker cannot be created,
completed workers are joined and the caller deterministically rewrites the
whole output serially. Small conversions, including the latency probe's 3×3
sample, remain serial. The bounded horizontal cache occupies about 192 KiB on
the caller's stack at the ABI's 8192-pixel dimension limit; a future asynchronous
conversion thread must reserve at least a 512 KiB stack.

## Work and memory bounds

- The native pending queue retains one I420 frame. Consumers can add only the
  leases they explicitly hold; `LiveViewRenderable` holds one lease only for a
  synchronous conversion.
- Bun polls at 1–30 FPS, with 15 FPS as the default. A slow or paused event loop
  reads the newest generation when it resumes rather than draining a backlog.
- RGBA output is fitted to terminal pixel capacity before conversion, never
  enlarged beyond the decoded display dimensions, and limited to 8192 pixels
  per dimension and 32 million pixels total. A larger Kitty placement is
  enlarged by Ghostty's linear GPU sampler, reducing CPU and terminal traffic.
- Conversion rotates, center-aligned-bilinear scales, and converts luma and
  chroma in one native pass. It allocates no source-sized RGBA intermediate;
  parallel row ranges write directly into disjoint parts of the caller's
  output buffer.
- `NativeImage.fromRgba` retains its own native image storage. The adapter keeps
  one exact-size caller-owned RGBA scratch buffer while connected and reuses it
  across conversions, replacing it only when fitted dimensions change.
- Each decoded WebRTC frame is still copied once into an immutable I420 frame,
  even when the OpenTUI poller will skip its generation. Producer-side
  throttling is a possible optimization only after measurements show that copy
  to be the limiting cost.
- The Input delivery queue has 256 physical slots. While explicit control is
  pending it admits at most 32 events for two seconds; adjacent motion and
  compatible scroll bursts coalesce before consuming another slot. Native sends
  occur outside its admission lock and only one drainer can call the outbound
  input channel at a time.

`LiveViewSubmissionMetrics` exposes frames submitted as `ImageRenderable`
sources, skipped generations, RGBA bytes and byte rate, output dimensions,
native conversion last/average/max duration, and time since the most recent
submission. Terminals do not provide an acknowledgement that the pixels became
visible. Native counters separately expose decode, queue, input-mapping, and
data-channel results. ABI version 3 adds monotonic input counters for pointer
move, pointer button, scroll, key, and paste. `attempted` counts semantic
submissions; `queued` counts attempts retained while explicit control is
pending; `coalesced` is the queued subset merged into an adjacent event; `sent`
and `send_failed` report native send results; `duplicate_suppressed` reports
state transitions intentionally omitted; and `control_dropped` reports
admission rejection, resident cancellation, queue overflow, or an in-flight
event invalidated by an epoch change. Cleanup and compensating release packets
remain packet-level work and do not increment semantic input counters; the
paste-ready Ctrl+V transitions are ordinary semantic key events and do.
The stages are deliberately not mutually exclusive: a queued event may later be
sent, and a native send that completes after cancellation is both sent and
control-dropped.

The same snapshot reports resident queue depth and capacity, the current input
epoch, and the sum and count of completed explicit-control waits. These are raw
counters and gauges rather than rates; consumers derive intervals or averages
from successive snapshots. An ABI version 2 comparison library has no input
snapshot, which the OpenTUI wrapper represents as `input: null`.

## Input-to-decoded latency probe

`bun run live-view:latency NAME` measures local submit-to-decoded-pixel elapsed
time through the headless ABI. It creates one temporary CDP page, waits for
Live View control before measurement, submits keys and pointer moves through
the normal Outbound input channel, and polls newer Frame leases at a declared
one-millisecond resolution. A 3×3 native conversion samples only the source
grid needed for detection and does not perform a full-frame conversion.

The page exposes two controlled workloads. `cell` changes one 128×128 region
around the decoded frame center, approximating a typing-sized residual without
forcing a keyframe. `viewport` changes the whole page, exercising bitrate and
keyframe behavior closer to a scroll or navigation. Dark and light sample
values are measured after encoder settling; every viewport sample, or the
center cell sample, must cross its own calibrated midpoint. Trial starts are
seeded and randomized across one declared capture interval to avoid aliasing
against the capture tick and one-second default keyframe cycle. Defaults are 60
measured trials, five warmups, and one second of quiet rate-control time between
trials.

A separate cadence phase animates the center cell by default and reports decoded FPS,
Frame-generation gaps, jitter-buffer render-timestamp intervals, and local
observation intervals, including the measured polling sleep. Pass
`--cadence-mode viewport` to exercise full-frame encoder cadence instead.
`LKRTCVideoFrame.timeStampNs` is libwebrtc's scheduled
local render time, not the RTP timestamp. Its deltas describe playout cadence;
they are never subtracted from Bun's `performance.now()` clock. The JSON report
also records the dylib path and size, comparison metadata, ABI version, Git
commit and dirty state, backend, decoded dimensions, declared capture FPS,
trial parameters, native counters, and Bun event-loop gaps.

This is Input-to-decoded latency, not display acknowledgement. It bounds the
shared capture/encode/network/jitter/decode path and headless poll, but excludes
AppKit Metal presentation and OpenTUI conversion, terminal transport, and
display refresh. The shared default's expected physical floor is 0–16.7 ms for
Chromium paint plus 0–33.3 ms for 30 fps capture, then encode, LAN transport,
jitter buffer, decode, and at most the declared poll interval. The capable
60 fps profile halves that capture window. Neko exposes no per-frame server
telemetry, so the probe cannot apportion those internal stages.

AppKit presents the decoded WebRTC buffer directly through LiveKitWebRTC's
Metal renderer. Its parallel observer is metadata-only, retaining decoded size
for input mapping without converting the same frame to I420 or publishing a
headless Frame copy. Headless/OpenTUI sessions retain raw publication because
their polling ABI owns conversion and presentation.

Terminal-protocol throughput, sustained CPU/RSS for Kitty graphics versus
block fallback, and presentation acknowledgement still need controlled adapter
runs. `bun run live-view:adapter NAME --json PATH` performs that run in a real
terminal. After one submitted frame and a configurable warmup, it reports
OpenTUI submission cadence and age, conversion duration, skipped frame
generations, Bun event-loop gaps, terminal dimensions, native counters, and
exact build provenance. Run it through `script(1)` when raw PTY byte volume and
Kitty command selection are part of the comparison; the probe itself never
claims a terminal display acknowledgement. Run that capture directly under the
terminal: a nested PTY relay may consume or omit capability replies and make a
supported Kitty medium appear unavailable. The design stays on OpenTUI's
public `NativeImage` and `ImageRenderable` APIs while carrying only measured
native renderer changes.
`config/opentui-carry.json` records its exact source and package artifact so the
pin can be removed cleanly when upstream contains the same behavior.
