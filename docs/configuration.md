# Deployment configuration

agentbrowse reads its version 2 deployment from
`~/.config/agentbrowse/config.json`; `AGENTBROWSE_CONFIG` may select another
absolute path for tests or an isolated installation. The file contains an
ordered `backends` array. Array order is provisioning priority, while each
backend `id` is stable identity recorded in target receipts and cleanup data.

Every backend has type `hypeman`. Supply an `id` and either a private
`connectionFile` (absolute or starting with `~/`) or inline `baseUrl` and
absolute `tokenFile`. Remote hosts additionally require `remoteHost` and a private
IPv4 `networkAddress`. The host installer generates these machine-local fields;
credentials never enter the tracked deployment file.

Resources: `cpus` defaults to 2, `memory` to `6G`, `profileSizeGb` to 1 and
`portOffset` to 2000. The 0–999 slot range is shared across hosts. Each backend
may override shared `video` settings. See `config.example.json` and
[Hypeman setup](hypeman.md).

Backend networking is a trust boundary. Remote Live View uses SSH to the
private VM, local Live View uses a loopback relay, and remote CDP/WebRTC use
owned forwards reachable only through Tailscale.

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
the example gives the remote Hypeman backend 60 fps, 4,792,320 bits/s, and a
60-frame keyframe interval while the Mac remains at the conservative default.
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

Host installation, image preparation and service enable/disable are explicit
administrator operations; browser launch never performs them. The host installer
configures service recovery, so an enabled service returns after login/reboot.
