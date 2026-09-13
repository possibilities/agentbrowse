# Guarded focus/scroll adapters and confirmed native pointer

Uses official unmodified agent-browser focus and scrollintoview commands. Adds no click/value assignment to either adapter. Requires unique selector, same lease/VM/page, unchanged value/checked/selectedIndex/raw numeric attrs, confirmed focus where requested, bounded settled rectangle, fresh fixed-display geometry and real native pointer mapping. Completion before/after includes bounds/current value and rect. Both actions remain native-state-unchanged in the supervisor plan; keyboard edits are separate acknowledgements.

Fixed a directly reproduced native pointer issue: xdotool mousemove --sync blocks if pointer is already at requested coordinates. Now send one move and read back actual X/Y within a bound, including repeated position. No repeated moves, guessed pointer overlay or agent-browser patch. Timeout diagnostics no longer stringify to an empty error.

## Validation and receipts

- Full bun run check238pass/5skip, lint/TypeScript/Zig (layout-full-check.log); eight Python recorder tests (layout-recorder-tests.log), including identical-position success and coordinate-mismatch refusal. Final fixture action-list changes follow observed keyboard rounding; no production code changes after these passes.
- Cancelled prior read-only Studio helper: `/Volumes/Scratch/agentvoice-campaign-2026-09/studio-rehearsal-owner-qui0_th4/browser/manifest.json`, failed-before-recording-released, driver50313 exited, no ready/capture and no cleanup error. No Studio relaunch.
- Fixture10 reproduced same-position --sync timeout through owned guest exec. Before/after pointer position identical. Recovered video hash/full decode before exact lease release, receipt `/Users/arthack/code/screencast-layout-fixture-10/capture/fixture-recovery.json`.
- Fixture11 proved focus/scroll preserve77 and native readback completes; found actual size PageDown77→69 then PageUp78. Expected77 assertion stopped safely. Source recovered/hash/full decoded and lease released; receipt at analogous fixture11 path.
- Fixture12 `/Users/arthack/code/screencast-layout-fixture-12`:23 actions completed, including offscreen range scroll/focus, same-position native pointer, exact size restoration and weight sequence, then scrollintoview#route. Trusted browser input events: size77→69→78→77 (PD,PU,ArrowLeft), weight250→230→210→190→210→230→250 (threePD/threePU). No input events from focus/scroll. These are actual fixture Chromium observations with Studio's observed raw bounds, not a live Studio action proof.
- Fixture12 stopped on host `EAGAIN: resource temporarily unavailable, posix_spawn '/Users/arthack/.local/bin/agent-browser'` during next click intent. No complete-fixture/menu-success claim for12. Recovered source SHA2565670c940bcebd2c687ebc865691174b7533a2bb545ae63c1d76d8464413a8d77, full decode, driver exit and UUID-fenced lease release confirmed in fixture-recovery.json. Remaining lease null. No automatic retry after resource failure.

## Remaining

Producer review of frozen source and actual value receipts; host process headroom confirmation before any next fixture/live turn. Existing successful menu-capture evidence remains from earlier fixture09, not this interrupted take. Composition/readability is producer-owned. No phone actions, Studio relaunch, global changes, new agent or agent-browser modification. The revised native script must acknowledge each actual intermediate value, including size78, and remain within its independent raw-time ceiling.
