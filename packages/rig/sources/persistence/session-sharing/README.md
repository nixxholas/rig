# Session-sharing persistence

These synchronous operations own the durable owner-share, grant, outbox, friend-message context,
member-replica, and entry-log state. Multi-row lifecycle changes use `inTx`; queries remain
ordered and bounded. Transport and service behavior live outside persistence and do not issue SQL.

Acknowledging the outbox (`sessionShareOutboxAcknowledge`) copies each published row into the
append-only `session_share_entries` log in the same transaction before deleting it from the
outbox, so an owner can always page durable history back to a newly invited member through
`querySessionShareEntryLog`.

Peer capabilities record what a shared-session member is allowed to do, one row per capability at the
member's current grant epoch. `sessionShareSetMemberCapabilities` writes the full set the owner wants
rather than a delta, because a delta on a security boundary would let two owner clients race and leave
whichever write landed last as the surviving permission. `querySessionShareMemberCapability` is the
durable half of the gate: a live capability is the presence of exactly one active row at the member's
current epoch while the member itself is active, and the absence of that row is denial with no third
state. A capability must never outlive the grant it rested on, so `sessionShareRevoke` and
`sessionShareStop` revoke capabilities in the same transaction that ends the grant — the FK cascade
only fires on row deletion, and those paths only flip state, so the revoke has to be explicit.

Every allow or deny decision is written to an append-only peer-action audit log keyed by a gapless
per-share sequence. The audit rows deliberately carry no foreign key on the member, because the record
of what a peer did must survive the member being revoked or the share being stopped. An audit log with
no bound is a disk leak, so `sessionSharePeerActionAppend` prunes on the write path — the same place
the entry log is pruned by its lifecycle transition — keeping the newest 10,000 rows within the last
30 days for each share, rather than relying on a background sweep.

Retention: the entry log exists only to offer past history to a member that joins later, so it is
bounded by the share's lifetime rather than kept forever. It is deliberately not truncated by
length — Murmur chains history offers rather than stopping at one, so every sequence stays
offerable and a cap would hand a late member a transcript with a hole in it. Stopping a share flips
its state without deleting the share row, so the `ON DELETE CASCADE` never fires; `sessionShareStop`
therefore prunes the log (`sessionShareEntryLogPrune`) in the same transaction as the stop, however
the share came to stop. A stopped share can never admit a new member, so it keeps no transcript
duplicate.
