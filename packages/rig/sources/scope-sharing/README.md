# Scope sharing

Sharing a whole workspace, or a whole project, with a friend. It is `session-sharing`'s sibling:
both ride the one transport, directory, and runtime in `../sharing/`, and neither generalizes into
the other.

```
sharing/                 one transport, one directory, one runtime, one router
   |                                        |
   +-- session-sharing/  one session        +-- scope-sharing/  one workspace or project
```

## What a member receives

One gapless owner-authored log whose entries carry a subject tag:

- `scope` — the project or workspace: name, title, status, git branch and head, ahead and behind,
  base ref and commit, and the folder's own name.
- `session_index` — one entry per session: title, description, agent kind, resolved provider and
  model labels, status, archived, timestamps, parent and root ids.
- `session_event` — the transcript, reusing `projectSessionShareEntry`'s projection verbatim so a
  member renders a shared workspace's conversation with exactly the code that renders a shared
  session.

## What a member never receives

File contents, diffs, blobs, the working tree, Git objects or packfiles, terminal streams,
background process output, secrets and credentials, Docker and external-tool and durable-skill
configuration, instructions and system prompts, permission state of any kind, and absolute paths —
at most a folder's own basename travels.

There is also no member write path at all. Nothing a member sends is ever applied to the owner's
workspace, project, or sessions; a post that arrives on an owner's scope channel is rejected rather
than interpreted.

## Scope and lifecycle

At most one live share per scope, which a partial unique index enforces. A workspace may not be
shared separately while its project is already shared, because the two would be separate MLS groups
over the same sessions with nothing to reconcile them.

A session inside a shared scope may still have its own session share. They are separate MLS groups
and revoking one does not revoke the other, which is a fact for the UI to show rather than a state
to unify.

Archiving a workspace stops its share and nothing else's. Archiving a project stops the project's
own share and every workspace share beneath it. A friend's replica creates no local project, no
local workspace, and no folder on disk: it lives entirely in the replica tables.
