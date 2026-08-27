# Connection descriptor

The application accepts exactly one JSON document from standard input when
started with `--connection-stdin`. This is the initial integration boundary;
there is no connection chooser in the application.

```json
{
  "version": 1,
  "label": "remote/local",
  "base_url": "http://127.0.0.1:18080",
  "username": "kernel",
  "password": "replace-me",
  "read_only": false
}
```

`base_url` can itself be sensitive when it is a hosted signed URL. Descriptor
contents must travel over stdin or an inherited descriptor, never process
arguments. Normal logs expose the label, URL scheme, loopback/non-loopback
classification, and connection state only. Clipboard contents, query strings,
credentials, SDP fingerprints, ICE credentials, session identifiers, and
desktop frames are never logged.

Periodic video metrics include decoded/failed/replaced frame counts and a
one-way checksum of the latest I420 frame. The checksum sink acquires the same
frontend-neutral frame lease intended for later adapters; no frame bytes are
written to disk.
