# agentbrowse

This repository contains a narrow integration proof: run the Kernel headful
browser image on the Docker host `artbird`, then control it from `greybird`
with `agent-browser` over Chrome DevTools Protocol (CDP).

## Topology

```text
~/src/kernel-images on greybird
        |
        | docker --context artbird build/run
        v
headful Chromium container on artbird
        |
        | CDP on artbird's tailnet address
        v
SSH forward on greybird (127.0.0.1:19222)
        |
        | agent-browser --cdp 19222
        v
agent-browser session on greybird
```

The container runs Xorg, Mutter, and Chromium. WebRTC/live-view and the Kernel
recording API are intentionally not published in this first integration slice.

## Prerequisites

- `docker context inspect artbird` reaches `ssh://artbird`.
- `docker buildx version` succeeds. Greybird converges the Homebrew formula and
  Docker CLI-plugin launcher from `~/code/funk`.
- `ssh artbird tailscale ip -4` returns artbird's tailnet address.
- `~/src/kernel-images` is a clean checkout on its intended branch.
- `agent-browser` and its browser support are installed on greybird.

The Kernel headful image requires an amd64 Docker host, a privileged container,
and 8 GiB of memory. Its first build can take around ten minutes.

## Run the proof

Build the current kernel-images revision on artbird:

```sh
./bin/kernel-browser build
```

Start the detached browser and wait for CDP readiness:

```sh
./bin/kernel-browser start
```

Inspect the container, verify the headful services, and fetch the CDP version
document:

```sh
./bin/kernel-browser status
```

In one terminal, keep a foreground SSH forward open:

```sh
./bin/kernel-browser tunnel
```

In another terminal, attach a stable agent-browser session and run a
navigation smoke test:

```sh
./bin/kernel-browser connect
./bin/kernel-browser smoke
```

The attached session remains available for ordinary agent-browser commands as
long as the tunnel is running. Pass `--cdp` on every command:

```sh
agent-browser --session agentbrowse-artbird-cdp --cdp 19222 snapshot -i
agent-browser --session agentbrowse-artbird-cdp --cdp 19222 open https://example.com
agent-browser --session agentbrowse-artbird-cdp --cdp 19222 screenshot /tmp/agentbrowse-artbird.png
```

Both `connect` and `smoke` set the CDP page viewport to 1280×720. Keeping the
remote page metrics aligned with the dashboard viewport makes mouse coordinates
land on the elements shown in the live canvas. Override both dimensions when a
different dashboard resolution is required.

With agent-browser 0.33.2, do not substitute `agent-browser connect <url>` for
the global `--cdp` option. The `connect` command can silently launch a local
Chrome instead of attaching to the requested remote endpoint. The helper's
`connect` command uses `--cdp` and verifies the attached WebSocket address.

Inspect logs or stop the container without deleting it:

```sh
./bin/kernel-browser logs
./bin/kernel-browser stop
```

`stop` deliberately preserves both the stopped container and its SHA-tagged
image. Deleting either is an explicit Docker operation outside this helper.

## Configuration

The command accepts these environment overrides:

| Variable | Default | Purpose |
| --- | --- | --- |
| `KERNEL_BROWSER_CONTEXT` | `artbird` | Docker context used for every container operation |
| `KERNEL_BROWSER_REMOTE_HOST` | `artbird` | SSH host used to discover the tailnet IP |
| `KERNEL_BROWSER_ARTBIRD_IP` | discovered with Tailscale | Explicit remote bind address |
| `KERNEL_BROWSER_SOURCE_DIR` | `~/src/kernel-images` | Local build context |
| `KERNEL_BROWSER_CONTAINER` | `agentbrowse-kernel-headful` | Remote container name |
| `KERNEL_BROWSER_IMAGE` | current source SHA tag | Complete image reference override |
| `KERNEL_BROWSER_CDP_PORT` | `9222` | Tailnet-side CDP port |
| `KERNEL_BROWSER_LOCAL_CDP_PORT` | `19222` | Greybird loopback port used by the SSH forward |
| `KERNEL_BROWSER_SESSION` | `agentbrowse-artbird-cdp` | Local agent-browser session |
| `KERNEL_BROWSER_VIEWPORT_WIDTH` | `1280` | CDP page width used for dashboard interaction |
| `KERNEL_BROWSER_VIEWPORT_HEIGHT` | `720` | CDP page height used for dashboard interaction |
| `KERNEL_BROWSER_SMOKE_URL` | `https://example.com` | Navigation target for `smoke` |

## Security boundary

CDP provides complete control of the browser and has no authentication here.
The Docker port is bound specifically to artbird's Tailscale IPv4 address, not
to `0.0.0.0`, so it is not exposed on artbird's LAN or public interfaces. The
SSH client exposes the forwarded endpoint only on greybird loopback. Tailscale
ACLs and SSH authorization remain responsible for deciding who can reach the
remote port. Do not browse sensitive accounts until those policies are known
to be appropriately narrow.
