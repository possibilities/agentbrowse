# 0007: Commit input state after serialized delivery

All semantic Live View input enters one bounded FIFO, and one drainer sends it
to the reliable ordered outbound input channel without holding a Zig lock across
native code. Held keys and buttons commit only after a successful send; one
epoch cancels resident work and makes an in-flight stale down issue a best-effort
release when the same transport is still open. Explicit control waits retain up
to 32 events for two seconds in that same queue rather than transferring them
through a separate replay buffer.
