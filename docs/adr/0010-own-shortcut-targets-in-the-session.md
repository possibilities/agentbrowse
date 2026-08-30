# 0010: Own shortcut targets in the Session

AppKit forwards every focused Command chord except local paste and quit, and
the Zig adapter chooses the guest target: allowlisted Command letters become
Control chords, Command-arrows become Home/End and Control-Home/End,
Option-arrows become Control-arrows, and other keys keep their reported keysym.
`Session.setPhysicalKey` admits the effective modifiers, the target transition,
and the physical restore as one batch under one admission lock, remembers the
target per physical key until its release, and clears every target together
with held input on blur, control loss, reconnect, and teardown. OpenTUI mirrors
the same rules over the public key event API.

Targets are level-correct rather than base-key plus flags: Neko resolves a
keysym against the guest's current modifier state and allocates a spare
keycode on every miss, so a lowercase keysym under Shift, or Caps-Lock
uppercase without it, would consume the guest keymap's spare keycodes until
those keys silently stop working (Neko logs the resulting X error rather than
exiting).
The adapter therefore sends the keysym at the guest's US-XKB level, forces or
removes Shift to match it, derives shortcut case strictly from physical Shift,
reconciles modifier keys side-neutrally, applies only the current key's
transform, and restores physical modifiers after a release without re-syncing.
