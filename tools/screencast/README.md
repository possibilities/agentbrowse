# Opt-in local Hypeman screencast helper

**Current checkpoint is not runnable for clean delivery:** automatic destructive release is deliberately gated pending immutable-instance fencing and owned driver-daemon cleanup. Do not start another live fixture from this checkpoint. Earlier fixture success predates these review fixes.

This review-stage helper uses the existing `local` Hypeman backend and installed agent-browser through its ordinary AgentBrowse provider. It opens no browser window on the Mac desktop. It does not install software, change backend defaults, trust a CA, start a Mac network listener, or weaken application Host/Origin validation. Integration and any real application script require separate review.

## Interface

```sh
bun tools/screencast/run.ts \
  --url http://127.0.0.1:4317/ \
  --script /absolute/path/reviewed-actions.json \
  --output /absolute/path/new-recording-directory \
  --seconds 60
```

The URL is required and grants exactly one explicit `http://127.0.0.1:PORT/` origin on the machine running the helper. The example is a contract, not permission to run Studio. Output must be a new private directory. `--seconds` is a hard recording ceiling of 5–120 seconds, not an instruction to stretch the action sequence to that duration. Capture stops after the actions and a short tail. Only the existing configured backend with ID `local`, no remote host and an IPv4-loopback API is accepted; there is no fallback.

The action file is a JSON array. Supported actions are `click {selector}`, `fill {selector,value}`, `press {key}`, `wait {ms}`, `expectText {selector,value}`, `expectValue {selector,value}` and `expectOpen {selector,value:"true"|"false"}`. Selectors and keys use installed agent-browser syntax. At most 100 actions are accepted; each wait is at most ten seconds. Expectations use bounded read-only reconciliation, never repeated input. Arbitrary eval, navigation, app restarts, uploads, downloads and shell commands are not action types.

```json
[
  {"type":"click","selector":"#route"},
  {"type":"expectOpen","selector":"#route","value":"true"},
  {"type":"wait","ms":1500},
  {"type":"press","key":"ArrowDown"},
  {"type":"press","key":"Enter"},
  {"type":"expectValue","selector":"#route","value":"splayed"}
]
```

The helper creates a unique disposable session/namespace, task-only provider configuration and isolated state directory. Keep its private `manifest.json` and `environment.json` for recovery. The manifest is initially `pending`; successful artifact verification and session release set `fixture-verified`. That label describes this helper's current review-stage validation, not Studio film readiness or approval of a script's content.

## Connection and ownership

The host reads the exact session lease and target receipt, verifies Hypeman ownership tags and pins the immutable instance ID. It rechecks the lease/instance every second and before actions. It also pins the real CDP page ID, URL and navigation time origin, and checks that agent-browser's page is visible. Replaced, stopped, foreign or ambiguous targets fail; there is no automatic reconnection or replay.

One authenticated Hypeman exec connection carries the bridge and control protocol. Hypeman 0.3.0 buffers non-TTY exec stdout until exit, so this helper uses its supported streaming TTY path and puts that guest terminal into raw mode before sending `hello`. Echo and newline translation are disabled. The Hypeman API credential stays in the local HTTP authorization header; it is never placed in argv, page content or receipts. Only non-secret helper source is in the audited exec command. The local-only API restriction avoids extending this transport's trust assumptions to a remote plaintext API.

The guest binds `127.0.0.1` at the same port as the Mac app. The host connects only to the one immutable Mac-loopback destination. The guest cannot request another host/port or use a SOCKS/CONNECT proxy. Host, Origin, cookies, relative URLs and streaming bytes travel unchanged. There is no host-facing listener, mDNS, DNS override, public exposure or routing/firewall change. The TCP transport is agnostic to HTTP streaming, but this slice accepts HTTP only; HTTPS trust, additional origins/ports, external redirects and remote Hypeman are unimplemented.

An irreversible unsafe latch stops both driver and native dispatch on observed ownership or transport failure. Already submitted input cannot be recalled. Grants have at most sixteen active connections. Both directions use bounded 16-KiB acknowledged chunks. Frames are capped at 64 KiB; host WebSocket backpressure is bounded at 1 MiB. Connection setup, socket writes and acknowledgements have finite deadlines. Revocation destroys active host sockets and closes guest sockets and the loopback listener. EOF and a three-second heartbeat expiry are independent crash backstops. The authenticated channel and exact VM identity replace the prototype's network bearer token. Other browser sessions never receive this VM or its channel. Pages within the explicitly granted session can reach the approved app; the grant does not authorize unrelated Mac services.

## Capture contract

Capture uses the guest's installed FFmpeg/X11 display, not agent-browser's screenshot recorder. It captures the genuine virtual desktop and native popup windows at 1920×1080 and 15 fps, with the native cursor included. The actual guest browser is fullscreen; no local Live View window is opened. The helper verifies viewport dimensions, scale and screen origin before actions. A real native hover moves the X pointer to measured element coordinates before agent-browser click/fill; this is documented additional input, not a synthetic overlay. The initial slice assumes stable, unzoomed, top-level controls. Arbitrary scrolling, iframes, moving layouts, drag gestures and touch are not validated.

Two successive native display samples are compared with the actual page screenshot before recording. A failed comparison gives no readiness acknowledgement. FFmpeg progress only establishes that the encoder is operating. A one-second captured lead-in precedes usable actions. After finalization, the helper decodes the source and identifies a verified stable source frame/PTS within that lead-in; earlier frames are excluded from the usable range. Similarity is evidence of the intended stable panel, not automatic verification of every menu or narrative detail. The producer still reviews decoded action frames.

Only child handles created by the helper receive signals. FFmpeg stdout/progress and stderr are continuously drained, stderr retention is bounded, and a finite recording limit is always present. Stop allows six seconds for SIGINT finalization and then kills/reaps the owned encoder within another two seconds. Encoder failure, reported drops, missing frames, missing stable lead-in or invalid timestamps leaves `pending`.

The source uses native timestamps with FFmpeg passthrough; it is not rebuilt from completed screenshot counts. Receipts include guest process clock brackets, frame timestamps, dimensions, duration, frame count and SHA-256. Process clock brackets do not identify the first encoded frame's exact UTC instant. Phone alignment still requires real shared visible events, one constant offset with explicit uncertainty and the same edit map; there is no per-action retiming.

## Finalization, failure and recovery

Intended normal order (currently gated before destructive release) is: stop/reap encoder, read guest size/hash, copy bounded chunks to a private local file, verify hash, fully decode, verify monotonically increasing source timestamps and the stable lead-in, revoke the bridge, then revalidate the saved VM identity and release the saved lease with its expected target/profile/backend tuple, confirming lease absence. Existing outputs are not overwritten.

All cleanup currently remains pending after exact identity revalidation; no destructive release is dispatched. The existing session API fences the saved lease/target but does not carry the original immutable instance ID through its fresh backend inspection. Name-only driver close is never used. The isolated driver daemon may remain idle; exact process cleanup remains a distribution blocker. After recording begins, a failed or cancelled run revokes access and stops the guest encoder but retains the exact lease/source as `pending` for explicit recovery. The private manifest records the lease, target, instance ID and an allocated guest source path before dispatching recorder start. If allocation itself fails, no recorder start is dispatched. This is intentional retained recovery state, not a healthy recording or an automatic retry. There is not yet a public recovery subcommand: inspect/copy/hash/decode that exact owned source through the authenticated exec API before releasing the exact lease. The test investigation exercised this recovery manually and retained its receipt. A production-facing recovery command and a crash-after-copy acceptance test remain follow-up work before broad distribution.

## Validation

```sh
bun test tools/screencast
python3 tools/screencast/test_recorder.py
python3 tools/screencast/fixture.py /absolute/path/new-fixture-directory
bun run check
```

The Python subprocess tests deliberately fill real pipes; their fake encoder is failure testing, not film proof. The serial live fixture uses a disposable Mac-loopback HTTP/SSE app, exact Host/Origin POSTs, a genuine select, a renderer stall, captured pointer, real source file and normal session cleanup. Never substitute the live Studio host for this fixture without the manager-coordinated reviewed rehearsal.

AgentBrowse owns this helper and its Hypeman session lifecycle. AgentStart's only prospective roles are distribution and a fleet-map update; no install/default change is part of this diff. A proposed paired fleet-map patch is included under `review/` for integration review.

Recorder budget begins at launch dispatch, before first-progress and lead-in. Running/recent-progress checks follow each action and the final tail; decoded end-event coverage remains a producer check. Active source size is capped at 256 MiB. The helper does not prove Studio tuning drags or section scrolling; observed keyboard equivalents require rehearsal.
