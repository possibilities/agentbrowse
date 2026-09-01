# 0012: Mirror the guest clipboard while hosting

Command-C is already translated to the guest's Control-C, so a copy lands in
the container's X11 CLIPBOARD selection and nowhere else. Neko answers an
XFixes selection-owner change by sending `clipboard/updated` to the control
host, and `Session` retains that text as a Clipboard observation. The AppKit
adapter writes each new generation to `NSPasteboard`; the OpenTUI adapter hands
it to the renderer's OSC 52 writer, which refuses a terminal that does not
report the capability. Neither adapter clears a local clipboard: an empty
observation, an oversized one, or a transport transition leaves what the
operator copied locally untouched.

The mirror is continuous rather than gated on a local copy chord. Only
continuous sync catches a page's own "Copy" button, which is how much of the
web offers text worth taking; a copy-intent window would silently drop those.
The cost is that any guest page can overwrite the operator's Mac clipboard
while this session holds control, so the sync is bounded to the control host by
Neko's own rule and stops entirely when control is released.

Setting the guest clipboard for a paste makes `xclip` take the CLIPBOARD
selection, which Neko reports straight back as a `clipboard/updated` carrying
the text we just sent. The session remembers one outstanding local write and
refuses its reflection, so Command-V never rewrites the clipboard it pasted
from. The guard is spent on that one match, so copying the same text in the
guest afterwards still reaches the adapters.
