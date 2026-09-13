# Cleanup delta: official unmodified agent-browser

The original VM UUID now travels from Sessions.release through fleet/farm destruction to Hypeman removeContainer. Farm checks it against the inspected instance before removing receipts; backend checks it again independently of refreshed observedIds and deletes by immutable UUID. Existing callers remain compatible without the optional pin. The same-name replacement regression deliberately refreshes observedIds first. Missing/replaced pinned instances preserve ownership.

The screencast helper uses the existing official agent-browser provider protocol and 30-second idle timeout. Its opt-in provider permits one launch and acknowledges exact driver detach while retaining the capture lease/source. The helper waits at most 45 seconds for its captured daemon PID to be absent and verifies the exact detach receipt before original-UUID release. No name-only close or process signals are used. Before further driver commands, the saved PID sidecar must still match. PID reuse or missing evidence conservatively remains pending. A crash during capture retains source/lease; the idle driver cannot delete it.

## Evidence

- Official installed agent-browser 0.33.2 unchanged (previous npm integrity and binary comparison receipt).
- `bun run check`: 230 pass, 5 skip, lint/TypeScript/Zig complete; `review/cleanup-full-check.log`.
- 31 focused existing/new release/provider/input tests; `review/cleanup-focused.log`.
- Two additional capture-provider tests: retains exact lease on detach; rejects foreign cleanup and repeated uncertain launch. Included in full check.
- Serial live disposable fixture: `/Users/arthack/code/screencast-cleanup-fixture-06`, exit 0, stage released, no lease remains. Owned driver PID 92513 exited through idle timeout, no signals.
- Source copied/hash-checked/full-decoded before lease release: `capture/source.mp4`, SHA256 `7d3483e00c14a7cbcd074ec486e2dc77c1e346fb7789f4389eadea187e5d38e7`.
- 1920x1080, 136 frames / 9.066667 s, 0 reported dropped/duplicated frames. Process brackets 9.311757 s are not encoded start-time proof. Stable source frame 0/PTS0, SSIM .999155.
- 27 exact Host/Origin-valid fixture requests; live SSE and trusted select-change receipts. Decoded `menu.png` at PTS6 visibly shows real popup and native cursor.

## Remaining bounded work

Producer review of this frozen delta. Same-target inspection/preparation seam before a reviewed Studio action sequence is still absent; static fixture scripts do not establish Studio selectors or framing. No Studio or phone run, no fleet install/default changes, no drag/scroll proof, no phone-sync acceptance. Public recovery CLI and additional crash-during-copy acceptance remain unimplemented. Current provider launch failure before capturing full owner identity remains explicitly pending instead of guessed cleanup.
