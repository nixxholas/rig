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
  opaque entry that travels. It is an allowlist: a friend receives the fields
  [`impl`](impl/README.md) names on purpose and nothing else.
- `SharedToolOutput.ts` is the owner's one setting for how much of each tool's
  work a share replicates, and the English sentence that describes it.
- `FriendAuthor.ts` is how a replicated message says who wrote it.

## What a friend sees of the agent's tools

A shared transcript describes what the agent did rather than everything it saw.
A tool call arrives as the sentence its own definition wrote for it — that a
file was read and how much of it, that a command ran and how it exited, how many
matches a search returned — while the file, the output, and the diff stay on the
owner's machine. A tool result whose payload was held back says so, so a friend
never has to guess whether a tool printed nothing.

An owner who wants a friend to see more sets the share's `toolOutput` to `full`
instead of the default `summaries`. That setting alone is not enough: raw output
crosses only for a tool that also declared `sharedOutputDisclosable`, so a
result that is sensitive by nature cannot be disclosed by flipping one switch.
Lowering the setting stops future disclosure; it cannot unsend what a member
already received.

What this does not promise: the conversation itself replicates whole, and the
agent's own prose is part of the conversation. An agent that quotes a file back
to the person it is working with has shared that quotation, and a compaction
digest is the same conversation rewritten. The boundary is around what tools
hand back, not around what anyone chose to say about it.

Entries are stamped `version: 2`. Version 1 is the older shape, in which a
handful of named fields were removed and everything else replicated verbatim;
its schema is still declared so an entry a replica already holds still matches
something, but nothing produces it any more. A replica stores the bytes it was
sent without decoding them, so the version is a marker for whoever reads an
entry rather than something the receiving side enforces.
