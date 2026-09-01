# 0012: Mirror the guest clipboard while hosting

Command-C is already translated to the guest's Control-C, so a copy lands in
the container's X11 CLIPBOARD selection and nowhere else. Neko answers an
XFixes selection-owner change by sending `clipboard/updated` to the control
host, and `Session` retains that text as a Clipboard observation. The AppKit
adapter writes each new generation to `NSPasteboard`; the OpenTUI adapter hands
it to the renderer's OSC 52 writer, which refuses a terminal that does not
report the capability. No observation the adapters decline to present costs the
operator their local clipboard: an empty observation, an oversized one, and a
transport transition all return before touching it, so a reconnect never wipes
what was copied locally.

One narrow exception is inherent to `NSPasteboard` and is accepted rather than
worked around. A write must be preceded by `clearContents`, so if another
process takes pasteboard ownership in the window between the two calls,
`setString:` fails and the pasteboard is left empty. The trigger is a
microsecond ownership race between two adjacent main-thread message sends; the
recovery — un-claiming the generation so a later tick retries — would need a
per-generation attempt cap to avoid retrying a contended pasteboard thirty
times a second, and that state costs more than the gap it closes. The mirror
recovers on the next guest copy.

The mirror is continuous rather than gated on a local copy chord. Only
continuous sync catches a page's own "Copy" button, which is how much of the
web offers text worth taking; a copy-intent window would silently drop those.
The cost is that any guest page can overwrite the operator's Mac clipboard
while this session holds control, so the sync is bounded to the control host by
Neko's own rule and stops entirely when control is released.

Setting the guest clipboard for a paste makes `xclip` take the CLIPBOARD
selection, which Neko reports straight back as a `clipboard/updated` carrying
the text we just sent. The session guards its own writes against that
reflection, so Command-V never rewrites the clipboard it pasted from. A match
retires its guard, so copying the same text in the guest afterwards still
reaches the adapters.

The guard is a bounded set of outstanding writes, and each entry is a length
plus a seeded digest rather than the pasted text. Pasting a credential into the
guest is a core use of a remote browser, so retaining the plaintext of every
paste for the guard's lifetime would be a stronger exposure than the logging
this code already refuses; a digest identifies the echo just as well and cannot
reconstruct the secret. The seed is drawn per session, because an unseeded
64-bit hash of a short password is dictionary-attackable offline by anyone who
obtains a digest. This is data minimization against local disclosure — a crash
report, swap, a debugger — not a remotely reachable vulnerability.

A set rather than one slot, because pastes queue behind control admission and
then drain back to back: with one slot the second write displaces the first, and
the first echo then republishes as a fresh observation that overwrites the local
clipboard with text the operator had already moved on from. Capacity is the
input queue's own waiting bound, so a full queue of pastes cannot outrun it.

Guards retire at the events that make an echo impossible, not on a timer. A
`clipboard/set` whose send fails never reached the guest; losing control — an
explicit release, another peer taking the host, a read-only session, or an
implicit-hosting session learning control was refused — stops Neko routing
`clipboard/updated` to us at all. Before this, transport loss was the only thing
that cleared a guard, so a paste followed by a control handoff left one armed for
the rest of the connection, silently swallowing a genuine later copy of that
text — most likely the very string just pasted in.

An entry still expires, but only as a liveness backstop, and that is a different
job from the one above. Because an overflowing set refuses the new guard rather
than evicting a live one, something has to guarantee room; expiry is what does
that. It is sized never to fire on a write still legitimately in flight — a
1 MiB paste, which `max_paste_bytes` permits, needs about eight seconds to
upload on a 1 Mbps uplink, so a two-second deadline would have expired the guard
before the write left the machine and let its echo through.

Refusing on overflow rather than evicting is deliberate. The oldest guard is the
one whose echo arrives next, so evicting it maximizes the chance of immediate
punishment: the local clipboard settles on an arbitrary middle paste. Refusing
settles it on the operator's most recent paste, which is where the text came
from, making the final write a content no-op in the common case.

One residual is accepted: a user who copies in the guest the exact text they
just pasted, inside the guard window, has that copy suppressed once. That is
inherent to echo-guarding by content without a server-side origin marker on
`clipboard/updated`, and the sixty-second backstop widens the window relative to
a shorter deadline. Retiring guards deterministically is what keeps the window
from being unbounded.
