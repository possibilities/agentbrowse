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

**Outbound input channel** — The client-created RTC data channel labeled
`data` that carries binary pointer and keyboard packets to Neko. Neko also
opens a same-labeled inbound channel; it must not replace this channel.
_Avoid: data socket, remote data channel._

**Input delivery queue** — The single bounded semantic FIFO that serializes
Live View input across frontend and native callback threads. Explicit control
waits keep events resident in this queue; authorization makes the same queue
deliverable, without transferring into a separate replay buffer.
_Avoid: pending input queue, replay queue._

**Cursor observation** — The bounded latest-value cursor image and remote
position retained by a Live View session from either known Neko data channel.
Frontend adapters decide whether and how to present it; it is not itself a
rendered cursor.
_Avoid: cursor event, cursor overlay, guest pointer._
