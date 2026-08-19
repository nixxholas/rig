# Titles

The names a first message settles: what the chat is called, and what the workspace and branch it
works in are called.

A chat opened from a client is called nothing at all, and a workspace opened with it is called
something like "Workspace 3", until there is anything to name them after. The first thing the person
says is that. This module turns it into names, and does it before the agent's own work starts: a
folder cannot be renamed once agents are working inside it, and a person should not watch a
placeholder while the answer arrives.

## How a name is written

Both names come out of one bounded inference. There are two names here and not three: the folder and
the Git branch carry the same one, because they are the same piece of work under two filesystems. A
chat title is the other, because prose read in a list is a different shape from a path segment. One
reading of the message settles both, and it has to, because a person is waiting on their own first
message while this runs.

The request runs on its own provider session, outside the agent loop, so nothing it says reaches the
history a person reads or the context the agent works from. It is never retried: a person is waiting
on their own first message, and an account that is signed out or spent will not answer differently
the second time.

The model is the cheapest one served by the account the chat already runs on — that account is the
only one known to be signed in and paid for — at the least reasoning effort the model accepts.
Writing three words does not deserve a reasoning budget.

Each name is asked for as its own tag, `<title>…</title>` and `<slug>…</slug>`, because that is the
shape models answer most reliably, and only the names still wanted are asked for. A greeting, a code fence or a closing remark around it is ignored; an answer with no tag at
all is read as the name itself. A chat title is bounded to six words and 80 characters; a workspace
or branch name is reduced to lower-case kebab-case and bounded to 48 characters. Text that is merely
too long is shortened rather than rejected — a slightly long name beats no name.

## The second look

A first message is a request, and a request is often not what the work turns out to be: the question
that became a rewrite, the bug report that became a design. So a chat is looked at once more, as soon
as there is more to go on than the message it was named after.

Two things count as more, and either one is enough: the agent has answered, or the person has written
again. Whichever comes first is what the second look reads. The turn ending is the usual one, but
someone watching a long turn run and saying what they actually meant should not have to wait for that
turn to finish before the chat stops being named after half of what they said.

The second look is the same cheap model on the same account, reading the conversation instead of the
opening message, and asked a different question: not "name this" but "is this still what it is
called". The title it was given is the answer unless the conversation plainly contradicts it, because
a title that keeps moving is worse than one that was slightly wrong — a person looking for the chat
again is looking for the name they last saw.

It happens once, and it happens off the critical path. The chat is claimed before the work starts so
that a restart, a second run or two triggers arriving together cannot each pay for a naming, and the
claim is handed back when the attempt produced nothing to keep. A chat where nothing has happened
that the first message did not already say is not asked about at all, and keeps its claim.

The workspace and the branch get no second look at all. A folder and a Git ref are named once,
because renaming either would move it out from under agents already working there.

## What it depends on

`new TitlesModule(config, workspaces)`.

| Module                                        | Why                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| [`ConfigModule`](../config/README.md)         | The accounts a name is written on, and the catalog the cheapest model comes from.                            |
| [`WorkspacesModule`](../workspaces/README.md) | The catalog a named workspace is renamed through, and what knows how a workspace's own name is put together. |

Nothing else is passed in. One name may take ten seconds, and that is a constant here rather than
a setting: it is how long a person will wait on their own first message. The clock is the module's
own.

## Public methods

- `nameFromFirstMessage(ctx, agentId, { firstMessage, providerId?, sessionNamed?, workspace? })` —
  the whole thing. It settles what is still wanted, hands the folder name to the workspaces catalog
  itself, and answers with the chat title for whoever keeps chats to write down. It never throws:
  the message it is naming is already on its way.
- `suggestNames(ctx, { firstMessage, wanted, providerId? }, { signal? })` — the names alone, without
  writing any of them anywhere.
- `refineChat(ctx, { transcript, currentTitle?, providerId? }, { signal? })` — the second look, given
  the conversation as plain text. It answers with the title to use, which is usually the one it was
  given.
- `claimChatRefinement(ctx, sessionId)` / `releaseChatRefinement(ctx, sessionId)` — takes the one
  second look a chat gets, and hands it back when it produced nothing.
- `workspaceWasNamed(ctx, workspaceId)` / `markWorkspaceNamed(ctx, workspaceId)` — the durable fact
  that a workspace has already taken the name of a chat.

## Storage

No tables. Everything this module remembers is one key answering one question about one thing, asked
by identity and never scanned, counted or joined, so it lives in the Agent KV store the collection
shares between its agents. The module takes hold of that store when the first agent is created or
restored, which is before anything can ask it anything.

Under `named` are the workspaces that have already been named from a chat. A workspace takes the name
of its first chat once and never again; the key is only written once a name has actually arrived, so
an attempt that failed leaves the next chat free to try.

Under `refined` are the chats whose second look has been taken. The key is written before the work
rather than after it, because the point is to keep two triggers from both paying for one naming, and
it is deleted again when the attempt produced no name. Writing it is one insert that only lands when
the key was absent, and the writer that wins is the one that finds its own token stored — a read
followed by a write would let two triggers arriving together both believe they had won.

A name is never a failure. Every method answers with `undefined` rather than raising when the model
declines, times out, or says nothing usable, and the message that would have been named is already
on its way.
