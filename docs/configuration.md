# Deployment configuration

agentbrowse reads its version 2 deployment from
`~/.config/agentbrowse/config.json`; `AGENTBROWSE_CONFIG` may select another
absolute path for tests or an isolated installation. The file contains an
ordered `backends` array. Array order is provisioning priority, while each
backend `id` is stable identity recorded in target receipts and cleanup data.

The two backend shapes are deliberately separate:

| Type | Required fields | Optional fields |
|---|---|---|
| `docker` | `id`, `context`, `remoteHost`, and exactly one of `networkAddress` or `networkAddressCommand` | `expectedEndpoint`, `expectedEngine` |
| `apple-container` | `id` | `command` (`/usr/local/bin/container`), `applicationRoot` (the conventional agentbrowse-infra runtime root), `maxTargets` (1), `cpus` (2), `memory` (`6G`) |

Apple's safe local shape is fixed to one 2-CPU, 6-GiB target. The application
root and command, when overridden, must be absolute paths. Duplicate or invalid
backend ids and version 1 files fail before any backend command runs.

The installed configuration keeps Artbird first and Apple second permanently.
Provisioning advances only when a backend's host or container service has a
classified availability failure. Authentication, context/engine identity,
malformed output, image absence, ownership drift, and capacity errors surface
without trying another backend. A running target's backend-bound receipt also
routes reuse and deletion directly to its original backend.

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
| `provider.name` | `AGENTBROWSE_PROVIDER_NAME` |
| `provider.description` | `AGENTBROWSE_PROVIDER_DESCRIPTION` |
| `liveView.labelPrefix` | `AGENTBROWSE_CONNECTION_LABEL_PREFIX` |
| `liveView.username` | `AGENTBROWSE_LIVE_VIEW_USERNAME` |
| `liveView.password` | `AGENTBROWSE_LIVE_VIEW_PASSWORD` |
| `liveView.readOnly` | `AGENTBROWSE_LIVE_VIEW_READ_ONLY` |
| `discovery.commandTimeoutMs` | `AGENTBROWSE_DISCOVERY_COMMAND_TIMEOUT_MS` |

`discovery.commandTimeoutMs` is bounded from 100 to 4000 ms. It limits passive
availability probes when the caller supplies cancellation; ordinary lifecycle
operations retain their normal transport timing.

Apple lifecycle and image preparation remain manual. If the local service is
stopped, run `agentbrowse-infra enable`; then use `agentbrowse-infra pull` or
`agentbrowse-infra load` intentionally. No agentbrowse provider or discovery
path invokes those commands, starts Apple services, or publishes a host port.
