# 0003: Poll Live View across the JavaScript runtime boundary

The public C ABI exposes snapshots, newest-generation frame leases, native RGBA
conversion, and synchronous input calls; it never invokes JavaScript from
NSURLSession or WebRTC worker threads. OpenTUI polls that ABI at a bounded rate
and accepts deliberate generation skips, keeping lifetime and thread ownership
inside the native core without requiring an OpenTUI fork. A direct OpenTUI
native plugin remains a benchmark-driven optimization if measured copies or
terminal image submission become the limiting cost.
