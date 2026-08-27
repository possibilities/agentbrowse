# 0002: Preserve the client-created outbound input channel

The client creates and retains the outbound input channel labeled `data`,
matching Kernel's web client. Neko also opens an inbound channel with the same
label; the native bridge observes but does not adopt it, because replacing the
outbound channel makes sends appear successful while Neko applies no input.
