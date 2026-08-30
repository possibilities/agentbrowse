# 0011: Scroll in Neko notch units with Session residuals

One Neko scroll unit is 1/120 of a wheel notch: the shipping xf86-input-neko
posts XI2 relative scroll valuators with a 120-unit increment, so fractional
notches are genuine smooth-scroll input. OpenTUI sends 120 units per SGR wheel
report because Ghostty has already accumulated motion to one terminal row or
column. AppKit precision scrolling sends -4 units per point through
`Session.scrollPrecise`, whose per-mode residual buckets (ordinary and
Control-scroll never mix) truncate toward zero, admit only whole units, keep
only the sub-unit fraction after i16 saturation, and reset after two idle
seconds, on discrete wheel input, and with every input cancellation. A sub-unit
event still requests control but enqueues nothing.

Discrete wheel input maps sign(delta) * max(|delta|, 1) * 120 because macOS
reports slow clicks as 0.1 and ramps with speed. Scroll queued while waiting
for control is capped at 1200 units per axis so a grant cannot replay a long
flick as one jump. The pinned Neko fork's XTest fallback still clicks once per
unit; that hazard is recorded in `docs/performance.md` as a fork follow-up.
