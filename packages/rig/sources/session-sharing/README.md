# Session sharing

One shared session: an owner replicates a single session's transcript to the
friends it invited, and their replies come back as context-only user messages.

The transport, directory, event router, and share identifiers live in
[`../sharing`](../sharing/README.md); this module owns only what is specific to
sharing a session.

```
  SessionShareService  --- publishes -->  outbox --> ShareTransport
        |                                                  |
        | friend post                                      | entries
        v                                                  v
  UserMessage (contextOnly, friendAuthor)            member replica
```

- `createSessionShareKind.ts` registers this kind into the one shared runtime: it
  builds the service and its daemon surface, offers the entry log as history, and
  joins, resumes, and recovers session shares.
- `SessionShareService.ts` owns the durable-outbox-plus-wake publish loop, member
  grants, revocation repair, and the replica side.
- `SessionShareDaemonService.ts` is the daemon's API boundary; every owner route
  resolves the share from its session, so a client only names the session it is
  looking at.
- `projectSessionShareEntry.ts` projects one session event or message into the
  opaque entry that travels, dropping anything that must never leave the machine.
- `FriendAuthor.ts` is how a replicated message says who wrote it.
