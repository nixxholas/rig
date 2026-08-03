# Scope-sharing persistence

These synchronous operations own the durable state of a shared workspace or project: the share
row, its members and grants, the per-session tail cursors, the outbox, the entry log, and a
member's replica. Multi-row lifecycle changes use `inTx`; queries remain ordered and bounded.
Transport and service behavior live outside persistence and do not issue SQL.

A scope share is the same machinery as a session share over a wider subject set, so the table
shapes deliberately mirror `session_shares` and `session_share_entries`. `scope_kind` is present
from the first migration: a project share differs from a workspace share only in which sessions
the subject query returns.

## One log, three subjects

Everything a member receives arrives as one gapless owner-authored log. Each entry carries a
subject tag so the member can tell the three apart without a second channel:

- `scope` — the project or workspace itself: name, title, status, git branch and head, ahead and
  behind, base ref and commit, and the folder's own name. Never the path that leads to it, never
  file contents or diffs, never Docker or external-tool configuration, never instructions or
  system prompts, never secrets, and never permission state.
- `session_index` — one session's place in the scope: title, description, agent kind, resolved
  provider and model labels, status, archived, timestamps, and parent and root ids.
- `session_event` — the transcript, reusing the session-share projection verbatim with the owning
  session id in the envelope.

A session share seeds itself from `session_messages` and then follows `session_events`. A scope
share follows `session_events` alone, from the first event each session ever recorded, because a
scope's session list is open-ended: sessions join and leave the scope while the share runs, so
there is no single moment at which a snapshot of "the transcript so far" could be taken. A session
whose durable messages predate its own event log — an imported or repaired transcript — is
therefore carried only from its first event.

## The round-robin tail

`sessionShareTailEvents` tails one session and can read until its page is full.
`scopeShareTailSessions` tails every session in the scope at once, so reading them in a fixed
order would let one busy session consume every pass forever while the rest of the workspace never
appeared to a member at all.

Each session therefore holds a place in a queue on `scope_share_session_cursors`, ordered by
`rotation_seq`. A pass serves the front of the queue first, gives each session at most
`sessionPageSize` entries, and moves the ones it served to the back. A session the pass could not
reach keeps its place, so it is first next time. `rotation_seq` is a counter rather than a clock
precisely so two cursors touched in the same millisecond still take their turns in order.

A `session_index` entry is written only once the session row it describes has actually moved past
the cursor's `index_version`, so identical facts are never published twice.

## Retention

Acknowledging the outbox (`scopeShareOutboxAcknowledge`) copies each published row into the
append-only `scope_share_entries` log in the same transaction as its deletion, so an owner can
always page durable history back to a member that joins later.

Nothing is ever superseded or pruned early — not in the entry log and not in the outbox. Murmur
requires a history offer to be strictly contiguous from the sequence a member asks after and
raises `sequence-gap` on the first page that is not, so removing any entry, however redundant its
content, would permanently break every later member's catch-up. That is why redundancy is
prevented upstream by `index_version` rather than cleaned up afterwards.

The log's retention is the share's own lifetime. Stopping a share only flips its state, so the
`ON DELETE CASCADE` never fires; `scopeShareStop` prunes the log in the same transaction as the
stop, however the share came to stop. A stopped share can never admit a new member, so it keeps
no transcript duplicate.
