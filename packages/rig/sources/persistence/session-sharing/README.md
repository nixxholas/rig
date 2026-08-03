# Session-sharing persistence

These synchronous operations own the durable owner-share, grant, outbox, friend-message context,
member-replica, and entry-log state. Multi-row lifecycle changes use `inTx`; queries remain
ordered and bounded. Transport and service behavior live outside persistence and do not issue SQL.

Acknowledging the outbox (`sessionShareOutboxAcknowledge`) copies each published row into the
append-only `session_share_entries` log in the same transaction before deleting it from the
outbox, so an owner can always page durable history back to a newly invited member through
`querySessionShareEntryLog`.
