---
name: browser
description: Drive the shared durable Agentbrowse browser through agent-browser, including signed-in interaction and live Agentattention handoff. Reach for it when a task needs clicking, forms, multi-step browser work, authentication, MFA, or a human challenge. For public page content without interaction use scrape; for finding pages use search.
---

# Browser — durable agent and human interaction

Agentbrowse supplies remote Kernel Browser targets and durable Browser profiles.
`agent-browser` is the agent's driver. Agentattention lets the human interact
with the exact same live target. Keep those lifetimes distinct:

- an **agent-browser session** is the stable name used on every driver command;
- a **Browser profile** preserves cookies, storage, and authentication across runs;
- a **Browser target** is one live container incarnation and is the exact object
  handed to Agentattention.

## Load the driver guide

Before the first `agent-browser` command in a task, load its installed,
version-matched guide:

```bash
agent-browser skills get core
```

That guide is authoritative for snapshots, refs, tabs, forms, waits, uploads,
downloads, and command flags. Do not guess or duplicate its changing command
surface from this skill. Add `--full` only when the task needs a detailed
command reference or template that the overview does not include.

## Use one stable session

Choose a short session name for the durable identity of the work, then use it
on every command:

```bash
agent-browser --session jobsearch open https://example.com
agent-browser --session jobsearch snapshot -i
```

The machine configuration selects Agentbrowse as agent-browser's provider. The
first command launches a Browser target backed by the session's durable Browser
profile. A later launch with the same session reuses its cookies and storage.

Do not add agent-browser `--profile`, `--restore`, `--state`, `--cdp`, or auth
vault persistence to this path. Those are separate local persistence and launch
models, not the Agentbrowse Browser profile the human shares. Never type or
extract a person's password, MFA secret, or reusable browser credential.

Follow agent-browser's snapshot → act → re-snapshot loop. Refs are transient;
after navigation or a meaningful page update, take a fresh snapshot before the
next ref-based action.

Use `scrape` for public page text that needs no live interaction. Read an active
signed-in page through this browser session when its rendered authenticated
state matters. Use `search` to find URLs.

## Hand the live page to the human

Load the `attention` skill when sign-in, MFA, a captcha, or another human-only
interaction blocks the prepared page. Then:

1. Navigate and fill everything the agent safely can in the named session.
2. Resolve that session to its current exact Browser target:

   ```bash
   agentbrowse resolve jobsearch --json
   ```

   Read `.data.target.name` from the successful envelope. Never substitute the
   stable session or profile name for this incarnation name.
3. Create one browser-interaction attention item with that target, a concise
   title, and enough context to tell the human what to do and what state to
   leave behind.
4. Issue no browser commands against the session while the human may control
   it. Wait for the durable attention outcome.
5. On `resolved`, re-snapshot the same agent-browser session and continue. The
   human's cookies and storage already belong to its Browser profile.

Do not pre-capture a signed-in profile. “Human needs to sign in” is an ordinary
browser-interaction item on the page the agent prepared.

If the item is returned stale, expires, or the exact target disappears, inspect
the current goal, replay the breadcrumb trail under the same stable session,
resolve its new target incarnation, and create a new attention item. Link the
replacement to the original with `--parent ORIGINAL_ID`. Agentattention and
Agentbrowse perform no inferred staleness or page reconstruction for the
producer.

## Close without losing authentication

After all attention items for the session are terminal and the browser work is
finished:

```bash
agent-browser --session jobsearch close
```

Close destroys only the current Browser target. Its Browser profile—and thus
authentication—remains for the next launch. Do not delete a Browser profile
unless the human explicitly asks to permanently remove that browser state.

Close finished sessions so the finite browser farm has capacity. Never close a
session while an open attention item still names its target.
