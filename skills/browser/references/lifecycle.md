# Browser lifecycle and transfers

AgentBrowse normally stops Chromium and syncs its profile before removing the
Browser target. If it reports `profile_shutdown_failed`, preserve the profile,
restore access to the host, and retry the normal close. `destroy` with `force`
abandons unflushed state and belongs only to an explicitly intended recovery of
an unresponsive target.

No close or destroy should race an open attention item naming the same target.
Resolve the human interaction first. Session identity persists across launches;
target identity does not. AgentBrowse and AgentAttention do not infer a stale
page's intended state or reconstruct it for the producer.

## Requested profile copy or transfer

Only export an authenticated profile when that transfer was requested. The
archive contains reusable authentication state; keep it private and send it
only to the authorized destination.

1. Close the profile's live target normally.
2. Describe and call AgentBrowse `profile_export` with `name` and an explicit
   absolute output `path`. It writes that local archive and can overwrite an
   existing file, so choose a new destination unless replacement is intended.
3. Call `profile_import` with the new name, absolute archive path, and the
   selected configured backend when needed. An existing destination profile or
   an active profile is refused.
4. For `profile_import_pending`, inspect the retained temporary target and the
   returned recovery. Remove only that exact temporary target when required,
   then retry with the intended archive.

These are Kernel-native archives, not a second driver restore or auth-vault
mechanism. Do not delete the original profile as a side effect of copying it.

## Result handling

Inspect MCP `isError` and AgentBrowse's `{schema_version, ok, error, data}`
envelope in `structuredContent`. If the host returns only content blocks,
parse the standalone JSON block and keep diagnostic prose separate. Read
`error.code` and `recovery` before retrying or claiming success.
Session resolution returns the exact target in `data.target.name`.

The agent-browser driver has its own returned schema. Inspect its declared
result and content blocks rather than assuming the AgentBrowse envelope.
Forward actual image content blocks when showing a screenshot; returning a
JSON object shaped like an image does not display it. If a tool returns a local
screenshot file, inspect that file with the native image tool.

Neither integration's successful transport response proves that a submission,
login, or download completed. Verify the resulting page, durable outcome, or
saved file as appropriate. Avoid replaying an external action after an unknown
outcome until that check resolves whether it already happened.
