# agentbrowse

This repository contains narrow integration proofs using the Kernel headful
browser image on the Docker host `artbird`: control it from `greybird` with
`agent-browser` over Chrome DevTools Protocol (CDP), or view and control a
separate browser through Kernel Live View.

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

separate headful Chromium container on artbird
        |
        | Neko HTTP on artbird loopback through SSH
        | WebRTC UDP on artbird's tailnet address
        v
Kernel Live View in a greybird browser
```

The CDP and Live View experiments use separate containers so either path can be
run or stopped without disturbing the other. Both reuse the same built image;
Live View is enabled entirely with container environment variables and port
publishing. Nothing in `~/src/kernel-images` is changed.

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

## Run the Kernel Live View proof

Start a second container from the already-built image with Neko enabled:

```sh
./bin/kernel-browser live-view-start
./bin/kernel-browser live-view-status
```

This does not rebuild the image or modify the kernel-images checkout. It passes
`ENABLE_WEBRTC=true`, configures Neko's single UDP mux port, and advertises
artbird's tailnet address at container creation time.

Keep the Live View HTTP forward open in one terminal:

```sh
./bin/kernel-browser live-view-tunnel
```

Then open the URL printed by the helper (by default
<http://127.0.0.1:18080>) in a browser on greybird. The bundled Kernel client
joins the Neko session and provides video plus mouse and keyboard control.
HTTP and its WebSocket stay on an SSH tunnel; WebRTC media uses UDP port 56000
directly over the tailnet.

The Live View container is independent of `agentbrowse-kernel-headful`. Stop it
without removing the container or image:

```sh
./bin/kernel-browser live-view-stop
```

If a stopped Live View container's image, environment, or port bindings no
longer match the requested configuration, `live-view-start` fails instead of
silently reusing it. Removing that container to recreate it is an explicit
Docker operation.

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
| `KERNEL_BROWSER_LIVE_VIEW_CONTAINER` | `agentbrowse-kernel-live-view` | Separate remote Live View container name |
| `KERNEL_BROWSER_REMOTE_LIVE_VIEW_PORT` | `18080` | Artbird loopback port for Neko HTTP |
| `KERNEL_BROWSER_LOCAL_LIVE_VIEW_PORT` | `18080` | Greybird loopback port used by the Live View SSH forward |
| `KERNEL_BROWSER_LIVE_VIEW_WEBRTC_PORT` | `56000` | Tailnet-bound Neko WebRTC UDP mux port |

## Security boundary

CDP provides complete control of the browser and has no authentication here.
The Docker port is bound specifically to artbird's Tailscale IPv4 address, not
to `0.0.0.0`, so it is not exposed on artbird's LAN or public interfaces. The
SSH client exposes the forwarded endpoint only on greybird loopback. Tailscale
ACLs and SSH authorization remain responsible for deciding who can reach the
remote port. Do not browse sensitive accounts until those policies are known
to be appropriately narrow.

Kernel Live View has the same trust assumptions for its control plane. Neko's
HTTP and WebSocket port is bound only to artbird loopback and reaches greybird
only through the loopback SSH forward. Its single WebRTC UDP mux port is bound
only to artbird's Tailscale IPv4 address. Anyone permitted by the applicable
Tailscale ACLs to reach that UDP port can send traffic to the media endpoint;
do not widen the bind or port range casually.
