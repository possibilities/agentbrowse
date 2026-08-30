# Deployment configuration

agentbrowse reads its version 2 deployment from
`~/.config/agentbrowse/config.json`; `AGENTBROWSE_CONFIG` may select another
absolute path for tests or an isolated installation. The file contains an
ordered `backends` array. Array order is provisioning priority, while each
backend `id` is stable identity recorded in target receipts and cleanup data.

The two backend shapes are deliberately separate:

| Type | Required fields | Optional fields |
|---|---|---|
| `docker` | `id`, `context`, `remoteHost`, and exactly one of `networkAddress` or `networkAddressCommand` | `expectedEndpoint`, `expectedEngine`, partial `video` override |
| `apple-container` | `id` | `command` (`/usr/local/bin/container`), `applicationRoot` (the conventional agentbrowse-infra runtime root), `maxTargets` (1), `cpus` (2), `memory` (`6G`), partial `video` override |

Apple's safe local shape is fixed to one 2-CPU, 6-GiB target. The application
root and command, when overridden, must be absolute paths. Duplicate or invalid
backend ids and version 1 files fail before any backend command runs.

The example configuration keeps a remote Docker backend first and Apple second.
Replace its documentation-only `192.0.2.10` address, Docker context, SSH host,
and engine identity with values for the deployment. Provisioning an unbound
Browser profile advances only when a backend's host or container service has a
classified availability failure. Before the first backend mutation, agentbrowse
durably reserves that backend as the profile's home so an interrupted creation
cannot retry against a different backend. Later launches keep the same cookies
and authentication even after the target is deleted. A bound profile never falls
through to a same-named empty volume elsewhere. Authentication, context/engine
identity, malformed output, image absence, ownership drift, and capacity errors
surface without trying another backend. Backend-bound target receipts route
reuse and deletion to exact container incarnations; the profile binding
separately persists the backend home.

Backend networking is a trust boundary. Docker Live View HTTP stays on the
browser host's loopback interface and is reached through SSH; Apple Live View
uses Apple's private container bridge. CDP and WebRTC trust the configured
private network. In particular, Agentbrowse adds no authentication in front of
CDP, so do not bind or route it onto an untrusted network. The `kernel`/`admin`
Live View values in `config.example.json` are public upstream compatibility
defaults and are not a security boundary.

When `images.defaultImage` is omitted, agentbrowse uses the exact `linux/amd64`
digest in the checked-in Kernel image lock. `AGENTBROWSE_IMAGE` and `--image`
remain explicit test or operator overrides; startup never consults a registry,
pulls an image, or builds one.

Shared policy fields remain under `browser`, `provider`, `liveView`, and
`discovery`. The supported environment overrides are:

| Field | Environment override |
|---|---|
| `images.defaultImage` | `AGENTBROWSE_IMAGE` |
| `browser.nekoLogLevel` | `AGENTBROWSE_NEKO_LOG_LEVEL` |
| `browser.timezone` | `AGENTBROWSE_BROWSER_TIMEZONE` |
| `browser.video.screenRefreshRate` | `AGENTBROWSE_BROWSER_VIDEO_SCREEN_REFRESH_RATE` |
| `browser.video.fps` | `AGENTBROWSE_BROWSER_VIDEO_FPS` |
| `browser.video.cpuUsed` | `AGENTBROWSE_BROWSER_VIDEO_CPU_USED` |
| `browser.video.threads` | `AGENTBROWSE_BROWSER_VIDEO_THREADS` |
| `browser.video.targetBitrateBps` | `AGENTBROWSE_BROWSER_VIDEO_TARGET_BITRATE_BPS` |
| `browser.video.keyframeMaxDistance` | `AGENTBROWSE_BROWSER_VIDEO_KEYFRAME_MAX_DISTANCE` |
| `provider.name` | `AGENTBROWSE_PROVIDER_NAME` |
| `provider.description` | `AGENTBROWSE_PROVIDER_DESCRIPTION` |
| `liveView.labelPrefix` | `AGENTBROWSE_CONNECTION_LABEL_PREFIX` |
| `liveView.username` | `AGENTBROWSE_LIVE_VIEW_USERNAME` |
| `liveView.password` | `AGENTBROWSE_LIVE_VIEW_PASSWORD` |
| `liveView.readOnly` | `AGENTBROWSE_LIVE_VIEW_READ_ONLY` |
| `discovery.commandTimeoutMs` | `AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS` |

The shared video default keeps Chromium's virtual display at 60 Hz while
capturing 30 VP8 frames per second with `cpu-used=4`, four encoder threads,
2,396,160 bits/s, and a 30-frame keyframe interval. Keeping display refresh and
capture cadence separate avoids constraining Chromium paint to the capture
clock. Each backend may merge a partial `video` object over that shared policy;
the example gives the measured Docker backend 60 fps, 4,792,320 bits/s, and a
60-frame keyframe interval while Apple remains at the conservative default.
Environment overrides have highest precedence and apply process-wide, so use
them for controlled tests rather than heterogeneous fleet policy. Capture fps
must not exceed screen refresh, `cpuUsed` is at least 1, and keyframe distance is
capped at 120 because the pinned Neko server ignores PLI/FIR.

Capture settings are part of target ownership verification. After upgrading to
this version, destroy and recreate every existing Browser target once; Browser
profiles, cookies, and authentication are preserved. Later policy changes use
the same explicit destroy/recreate migration. `list`, `resolve`, and `view` do
not mutate or re-verify the container, but provider launch or `create` rejects a
drifted existing target instead of silently running different capture settings.

`AGENTBROWSE_STATE_DIR` selects an alternate directory for durable profile
bindings. It defaults to `$XDG_STATE_HOME/agentbrowse` or
`~/.local/state/agentbrowse`. `AGENTBROWSE_RUNTIME_DIR` continues to isolate
ephemeral target receipts and, when set for tests without an explicit state
directory, also nests the durable-state fixture beneath that runtime directory.

`discovery.commandTimeoutMs` is bounded from 100 to 4000 ms. It limits passive
availability probes when the caller supplies cancellation; ordinary lifecycle
operations retain their normal transport timing.

Apple lifecycle and image preparation remain manual. If the local service is
stopped, run `agentbrowse-infra enable`; then use `agentbrowse-infra pull` or
`agentbrowse-infra load` intentionally. No agentbrowse provider or discovery
path invokes those commands, starts Apple services, or publishes a host port.
