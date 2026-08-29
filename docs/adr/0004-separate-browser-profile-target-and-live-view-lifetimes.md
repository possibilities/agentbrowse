# 0004: Separate Browser profile, target, and Live View lifetimes

A Browser profile is durable Chromium state in a backend-owned named volume, a Browser
target is one uniquely named Kernel container incarnation mounting it, and a
Live View session connects to that exact target. The provider maps each
agent-browser session to a profile, preserves the profile when closing its
target, and allocates a fresh target identity after close so stale references
cannot reach a replacement. Only one container may mount a profile for writable
use, and profile deletion is explicit.
