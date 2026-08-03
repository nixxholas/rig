# Session-sharing persistence

These synchronous operations own the durable owner-share, grant, outbox, friend-message context,
member-replica, and entry-log state. Multi-row lifecycle changes use `inTx`; queries remain
ordered and bounded. Transport and service behavior live outside persistence and do not issue SQL.

Acknowledging the outbox (`sessionShareOutboxAcknowledge`) copies each published row into the
append-only `session_share_entries` log in the same transaction before deleting it from the
outbox, so an owner can always page durable history back to a newly invited member through
`querySessionShareEntryLog`.

Retention: the entry log exists only to offer past history to a member that joins later, so it is
bounded by the share's lifetime rather than kept forever. It is deliberately not truncated by
length — Murmur chains history offers rather than stopping at one, so every sequence stays
offerable and a cap would hand a late member a transcript with a hole in it. Stopping a share flips
its state without deleting the share row, so the `ON DELETE CASCADE` never fires; `sessionShareStop`
therefore prunes the log (`sessionShareEntryLogPrune`) in the same transaction as the stop, however
the share came to stop. A stopped share can never admit a new member, so it keeps no transcript
duplicate.
