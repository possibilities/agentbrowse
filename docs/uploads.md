# Remote file uploads

agent-browser sends file-input paths to Chrome with CDP
`DOM.setFileInputFiles`. For an AgentBrowse provider session, Chrome runs inside
the remote Browser target. A path that exists only on the agent's machine is
absent there; the command can still return success while the page receives a
file with the right name and MIME type but zero bytes.

Open the agent-browser session before staging a file:

```sh
agent-browser --session publish-task open https://example.com/upload
agentbrowse session stage publish-task /absolute/path/to/video.mp4 --json
```

The successful envelope contains:

```json
{
  "session": "publish-task",
  "profile": "personal",
  "target": { "name": "publish-task-…", "backend": "artbird" },
  "path": "/tmp/agentbrowse-upload-…/video.mp4",
  "bytes": 8384140,
  "sha256": "…"
}
```

Pass `data.path` to agent-browser's ordinary upload operation with the same
session and a fresh page ref or selector. Do not pass the original local path.
Selection is not proof that the page consumed the bytes: inspect the resulting
UI or the file input and confirm its `File.size` matches `data.bytes` before any
submission.

AgentBrowse accepts one absolute, readable regular file per staging call. It
hashes the local source, creates a random mode-0700 directory under `/tmp` in
the exact Browser target, streams the file with mode 0600 through Kernel's
native `/fs/write_file`, transfers ownership to Chromium's `kernel` user, and
checks `/fs/file_info` plus the guest's SHA-256. A size or digest mismatch fails
closed and removes only that newly generated directory. The returned path is
never stored in the Browser profile or a session receipt.

Staged uploads share the Browser target's lifetime. Normal agent-browser close
deletes the target and its temporary files while preserving an explicitly saved
Browser profile. A failed close retains the target, including its staged files,
for safe recovery; `session release` with the exact lease retries the same
owned cleanup. AgentBrowse never treats staging as permission to select a page
input, submit a form, or publish content.
