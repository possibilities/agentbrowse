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

**Outbound input channel** — The client-created RTC data channel labeled
`data` that carries binary pointer and keyboard packets to Neko. Neko also
opens a same-labeled inbound channel; it must not replace this channel.
_Avoid: data socket, remote data channel._
