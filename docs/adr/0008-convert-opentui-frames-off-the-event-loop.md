# 0008: Convert OpenTUI frames off the event loop

OpenTUI transfers each acquired Frame lease to one process-wide Bun Worker. The
Worker serializes native I420-to-RGBA calls, writes into a per-renderable shared
buffer, and releases the lease in `finally`; the main thread performs only the
synchronous `NativeImage` copy and source assignment. One atomic ownership word
lets the main thread claim a release if the Worker dies before doing so.
If a Worker dies inside the native release itself, after atomically claiming
release ownership but before publishing completion, one frame lease can remain
unreleased. The main thread deliberately does not retry that ambiguous state:
leaking one frame is safer than risking a double release and use-after-free.

The Worker probes the exact absolute ABI version 2/3 dylib before any lease is
transferred. Startup or probe failure converts the same frame synchronously,
and a later infrastructure failure makes future frames use that fallback. Busy
poll ticks acquire nothing, completed buffers are committed only when their
session operation and fitted dimensions are still current, and no ABI version
change is required.
