# Context

**Browser profile** — Durable browser state stored independently of any Browser target,
including cookies, local storage, IndexedDB, and authentication. At most one Browser
target may mount a Browser profile for writable use at a time.
_Avoid: browser session, user profile, target._

**Browser target** — One named Kernel headful container on the configured host, exposing
both a Chrome DevTools Protocol endpoint and the services needed for Live View.
Its numeric slot deterministically assigns its host ports.
_Avoid: browser session, Docker target._

**Browser provider** — The short-lived `agentbrowse provider` process that
implements agent-browser's `browser.provider` protocol over standard input and
output. It provisions or reuses one Browser target for a launch request and
destroys that target for the matching close request.
_Avoid: provider server, deployment-specific provider names._

**Agent-browser session** — A stable agent-browser driver name that the Browser
provider maps to one Browser profile and, while running, one exact Browser target
incarnation. Closing and relaunching it preserves the profile but changes the target.
_Avoid: Browser session, target name, profile name._

**Ordered backend set** — The configured sequence of independently identified
Browser target runtimes. Provisioning considers them in order and advances only
when the current backend reports a classified availability failure.
_Avoid: failover list, provider chain._

**Availability classification** — A pre-mutation result that says a backend's
host or container service cannot currently be reached. It is the only failure
class that permits provisioning to continue to the next configured backend.
_Avoid: retryable error, generic fallback error._

**Backend-bound target receipt** — The versioned runtime record that binds one
Browser target to its Browser profile, backend identity, exact generated container
identity, target name, and slot. Cleanup routes through that backend and rechecks
runtime ownership labels before deletion.
_Avoid: env file, generic target metadata._

**Profile binding receipt** — The durable local record that assigns one Browser
profile to the backend that owns its authentication state and, while running, its
current exact Browser target. Target deletion clears the target but preserves the
backend home; explicit profile deletion removes the receipt.
_Avoid: target receipt, session receipt, failover cache._

**Live View session** — One authenticated connection to a Kernel/Neko endpoint,
including its WebSocket control plane, WebRTC peer, control ownership, decoded
frames, and input state.
_Avoid: browser session, viewer session._

**Connection descriptor** — The bounded JSON document delivered to the app over
standard input or an inherited file descriptor. It identifies exactly one Live
View session and may contain secrets.
_Avoid: profile, target record._

**Frame lease** — A retained, immutable view of one decoded video frame with an
explicit release operation. The producer and every consumer own separate
references.
_Avoid: image, frame pointer._

**Frontend adapter** — A consumer of the platform-neutral session, frame, and
input APIs. AppKit and OpenTUI are frontend adapters; neither owns transport or
control policy, and the OpenTUI adapter does not import AppKit types.
_Avoid: viewer, skin._

**Frame conversion Worker** — The one process-wide Bun Worker that serializes
OpenTUI I420-to-RGBA jobs, owns each transferred Frame lease through release,
and writes into a per-renderable shared buffer. It is an event-loop isolation
boundary, not a second frame queue or native ABI.
_Avoid: render thread, conversion queue._

**Outbound input channel** — The client-created RTC data channel labeled
`data` that carries binary pointer and keyboard packets to Neko. Neko also
opens a same-labeled inbound channel; it must not replace this channel.
_Avoid: data socket, remote data channel._

**Input delivery queue** — The single bounded semantic FIFO that serializes
Live View input across frontend and native callback threads. Explicit control
waits keep events resident in this queue; authorization makes the same queue
deliverable, without transferring into a separate replay buffer.
_Avoid: pending input queue, replay queue._

**Input-to-decoded latency** — Local elapsed time from submitting one semantic
input through a Live View session until its expected pixel transition is
observed in a decoded Frame lease. It excludes AppKit Metal presentation and
terminal presentation, so it is a controlled transport bound rather than a
glass-to-glass claim.
_Avoid: display latency, glass-to-glass latency._

**Cursor observation** — The bounded latest-value cursor image and remote
position retained by a Live View session from either known Neko data channel.
Frontend adapters decide whether and how to present it; it is not itself a
rendered cursor.
_Avoid: cursor event, cursor overlay, guest pointer._

**Clipboard observation** — The bounded latest-value guest clipboard text a Live
View session retains from `clipboard/updated`. Neko sends it only to the control
host, so it stays empty until the session holds control. Frontend adapters decide
whether and how to write it to a local clipboard; it is not itself a clipboard
write.
_Avoid: clipboard sync, remote clipboard, pasteboard._

**Physical key target** — The guest keysym plus removed and forced modifier
flags chosen when one physical key was pressed. The Live View session keeps it
until that key's release so the release and its Shift level stay correct
regardless of later modifier changes, and clears it together with held input.
_Avoid: key translation entry, shortcut map, held key._

**Shortcut translation** — A Frontend adapter's mapping of one macOS chord
(Command or Option plus a key) to a Physical key target that carries the Linux
guest's convention: Control chords, Home/End, Control-arrows. Chords without a
translation reach the guest as ordinary Meta or Alt input.
_Avoid: key remap, hotkey, keybinding._

**Pixel mouse fence** — The serialized DECRQM 1016 query written after every
pixel-mouse mode transition. The OpenTUI stdin parser changes SGR report units
only at the byte that completes its DECRPM reply, so byte-identical cell and
pixel reports are never misread across the transition.
_Avoid: mouse mode flag, pixel toggle, capability sync._

**Neko scroll unit** — One 1/120 of a wheel notch, the XI2 scroll valuator
increment posted by the xf86-input-neko driver that ships in the Kernel image.
Every scroll packet carries whole units; 120 is one discrete notch.
_Avoid: pixel, line, tick, wheel delta._

**Scroll residual bucket** — The Live View session's per-mode (ordinary or
Control-scroll) fractional remainder of precision scrolling in Neko scroll
units. Only whole units are admitted from it; it resets after idle, on discrete
wheel input, and with every input cancellation.
_Avoid: scroll accumulator, smoothing buffer, momentum state._
