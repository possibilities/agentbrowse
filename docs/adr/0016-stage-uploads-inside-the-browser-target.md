# 0016: Stage uploads inside the exact Browser target

AgentBrowse stages each local upload into a private temporary path inside the
Agent-browser session's exact running Browser target before agent-browser
selects it. The staging command streams through Kernel's native filesystem API,
then verifies the guest byte count and SHA-256 against the local source. The
file remains outside the Browser profile and target deletion owns its cleanup.

agent-browser 0.33.2 implements upload by sending the caller's path verbatim in
CDP `DOM.setFileInputFiles`. With a remote provider, that path is resolved by
Chrome inside the Browser target. An agent-local path can therefore produce a
zero-byte DOM `File` while the driver reports success. Changing AgentBrowse's
provider response cannot rewrite a later page command, and moving selectors or
page actions into AgentBrowse would violate the boundary established in
[0005](0005-own-the-browser-agent-skill.md).

`session stage` and its generated `session_stage` MCP tool are the transfer
primitive. They resolve the current session first, so a stopped, missing,
ambiguous, or replaced target is refused by the existing ownership checks. A
random guest directory avoids collisions and symlink reuse. Mode 0700 on the
directory and mode 0600 on the file limit access to Chromium's `kernel` user.
Partial failures remove only the validated random directory; a cleanup failure
is explicit and recovered by closing the target.

The browser workflow passes only the returned guest path to agent-browser and
verifies the page-observed file size before proceeding. Staging does not select
an input, submit a form, or grant publication authority. Repeating staging
creates a new temporary path so an uncertain result cannot silently alias an
earlier transfer. Normal provider close removes every staged upload with the
Browser target while retaining any saved Browser profile under
[0015](0015-explicit-profile-retention-and-session-leases.md).
