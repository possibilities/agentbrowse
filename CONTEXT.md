# Context

**Browser target** — One named Kernel headful container on Artbird, exposing
both a Chrome DevTools Protocol endpoint and the services needed for Live View.
Its numeric slot deterministically assigns its host ports.
_Avoid: browser session, Docker target._

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
input APIs. AppKit is the first frontend adapter; a future OpenTUI frontend
adapter must not import AppKit types.
_Avoid: viewer, skin._

**Outbound input channel** — The client-created RTC data channel labeled
`data` that carries binary pointer and keyboard packets to Neko. Neko also
opens a same-labeled inbound channel; it must not replace this channel.
_Avoid: data socket, remote data channel._
