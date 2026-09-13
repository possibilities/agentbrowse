# Same-target preparation and coordination delta

Adds optional --prepare-wait60..900 (recommend600) and --coordination-wait1..10 (recommend5). One helper owns all driver calls. Fresh evidence is emitted every10s on the same pinned session/lease/VM/page; the producer authors while native recording remains off. Atomic ready binds preparation nonce, identity SHA and exact script bytes. Accepted bytes are saved without reserialization. Guest exec lifetime300+prepareSeconds stays finite and independent of capture bounds.

Every coordinated action is intent → matching file-hash permit → one genuine dispatch → completion → matching completion-hash ack. Next intent waits for ack. Supervisor owns full native-state validation; helper performs no phone operations. Immediate fatal file, pre-dispatch external abort checks and early terminal browser-stop file let the supervisor react before copy/decode/idle cleanup. See preparation-protocol.md for exact fields/filenames. Incoming document memory is bounded1MiB, invalid replies fail closed, absent replies never authorize.

## Evidence and limits

- Full `bun run check` log: review/preparation-full-check.log (234 pass /5 skip plus lint/TypeScript/Zig).
- New regressions: wrong preparation identity/script bytes, finite authoring bounds, wrong action hashes/explicit rejection, missing reply timeout and cancellation. Earlier lifecycle and bridge regressions still pass.
- Disposable coordinated fixture07 `/Users/arthack/code/screencast-preparation-fixture-07`: exit0, released, same target through35s authoring pause beyond driver's30s idle timeout,11 exact handshakes, next intent withheld during mock ack delay, stop signal observed before process exit. Source copied/hash/full decoded before release; SHA256 d8e7065d5b8fef0c38b9625d46ec4d4abc6ed61af0b20206edbad42461264393.
- Disposable abort fixture08 `/Users/arthack/code/screencast-preparation-abort-08`: expected exit1; supervisor abort during preparation, no recording start/no action intents, helper-failure published, stage failed-before-recording-released, exact driver exit and lease release confirmed.
- Fixture07 predates immediate latch-failure publication and final byte-preserving receipt/read-bound changes; fixture08 includes immediate failure publication. Final source check covers all final edits. Neither is a native-device test. No live fixture has run against Studio.

Native supervisor implementation/review is separate, with producer as sole owner. It must establish exact full-state acknowledgements, native baseline/ownership, raw60s budget with stop margin and real shared-event synchronization. Host fixture acknowledgements are simulated and prove only ordering. No agent-browser modifications, global installation/configuration changes or phone/Studio operations.
