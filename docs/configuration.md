# Deployment configuration

agentbrowse keeps deployment identity outside the repository. By default it
reads `~/.config/agentbrowse/config.json`; `AGENTBROWSE_CONFIG` selects another
absolute path. Copy `config.example.json`, replace every example deployment
value, and keep the resulting file mode `0600` because Live View credentials
may be present.

The version 1 fields are:

| Field | Purpose | Environment override |
|---|---|---|
| `docker.context` | Docker context used for browser containers | `AGENTBROWSE_DOCKER_CONTEXT` |
| `docker.expectedEndpoint` | Optional identity check for the context endpoint | `AGENTBROWSE_DOCKER_ENDPOINT` |
| `docker.expectedEngine` | Optional identity check for the reached engine | `AGENTBROWSE_DOCKER_ENGINE` |
| `remote.host` | SSH destination used for address discovery and Live View forwarding | `AGENTBROWSE_REMOTE_HOST` |
| `remote.networkAddress` | Stable IPv4 address used for CDP and WebRTC binds | `AGENTBROWSE_NETWORK_ADDRESS` |
| `remote.networkAddressCommand` | Alternative remote command that prints the IPv4 address | `AGENTBROWSE_NETWORK_ADDRESS_COMMAND` |
| `images.defaultImage` | Optional already-loaded default image | `AGENTBROWSE_IMAGE` |
| `images.sourceDirectory` | Checkout whose Git revision selects the default image tag | `AGENTBROWSE_KERNEL_IMAGES` |
| `browser.nekoLogLevel` | Neko log level; defaults to `info` | `AGENTBROWSE_NEKO_LOG_LEVEL` |
| `browser.timezone` | Optional `TZ` passed into new browser containers | `AGENTBROWSE_BROWSER_TIMEZONE` |
| `provider.name` | agent-browser provider identity; defaults to `agentbrowse` | `AGENTBROWSE_PROVIDER_NAME` |
| `provider.description` | provider manifest description | `AGENTBROWSE_PROVIDER_DESCRIPTION` |
| `liveView.labelPrefix` | connection descriptor label prefix | `AGENTBROWSE_CONNECTION_LABEL_PREFIX` |
| `liveView.username` | Neko username | `AGENTBROWSE_LIVE_VIEW_USERNAME` |
| `liveView.password` | Neko password | `AGENTBROWSE_LIVE_VIEW_PASSWORD` |
| `liveView.readOnly` | whether Live View input is disabled | `AGENTBROWSE_LIVE_VIEW_READ_ONLY` |
| `discovery.commandTimeoutMs` | signal-aware remote discovery deadline, 100–4000 ms | `AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS` |

Set either `remote.networkAddress` or `remote.networkAddressCommand`. A static
address avoids an extra remote command; a command accommodates addresses that
can change. The command is deployment-owned and is passed as the remote command
to SSH—agentbrowse does not assume a particular network product.

Host identity values are optional but recommended. When present, agentbrowse
checks the local Docker context endpoint before contacting it and checks the
engine name after connecting. This prevents an accidentally selected context
from managing the wrong machine.

The 2000 ms discovery deadline is active only when a caller supplies an
`AbortSignal`, as the OpenTUI picker does. Create, provision, destroy, and other
ordinary lifecycle operations retain their existing transport timing. The
picker keeps its independent five-second outer deadline for custom target
sources and unknown stalls.

Configuration remains lazy in the OpenTUI path: the empty surface does not read
the file or contact the host. Opening the browser picker starts discovery;
choosing a target starts the tunnel and reads Live View connection settings.
