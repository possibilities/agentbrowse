# 0009: Fence pixel-mouse units in the stdin parser

OpenTUI enables DEC private mode 1016 only after a DECRPM reply reports it
(states 1, 2, or 3), never under tmux, zellij, or screen, and always as the
last mouse mode written. SGR cell and SGR pixel reports are byte-identical, so
every 1016 transition is followed by one serialized DECRQM, and the parser
changes report units only at the byte that completes that reply, carrying the
pending fence target in its own protocol context. The renderer mirrors the
transition but does not own it: its capability handler is removed after the
startup window, so a fence armed by suspend/resume or focus-in would otherwise
never resolve, and a drain-time flip would misread reports that share a chunk
with the reply.

Pixel reports hit-test in cells derived from the terminal's CSI 14 t
resolution and are dropped while no valid resolution exists or a resize
re-query is pending. Disabling 1016 re-enables SGR cell mode because Ghostty
reverts to X10. The carried OpenTUI build is recorded in
`config/opentui-carry.json`; stock OpenTUI falls back to cell-center mapping.
