# Rig connect

`rig-connect` gives a user interface the live state of Rig from one subscription. It connects to a
Rig endpoint, follows a stream, keeps the state in memory, and hands it to the caller as ordered
values plus a stream of deltas.

There are two subscriptions, because there are two questions. `connectSession` answers what is
happening inside one conversation. `connectGroups` answers what projects, worktrees, and sessions
exist. They are independent: a session list does not require a session connection, and a
conversation does not require the catalog.

It is the only place in the product where sync is reasoned about. A UI embeds it and renders; it
never asks the daemon a follow-up question to understand what it was just told. The single
exception is paging back beyond the opening transcript window, described under The protocol.

The library depends on nothing but plain Web APIs — `fetch`, streams, `AbortController`, and
standard timers — so the same build runs in Node, in a browser, and in any runtime that provides
them. It has no runtime dependency on the `rig` package, and a browser bundle carries no daemon
code.

## Creating a connection

```ts
import { connectSession } from "@slopus/rig-connect";

const connection = connectSession({
    endpoint: "http://127.0.0.1:4517",
    sessionId: "01960f2c-...",
    token: process.env.RIG_TOKEN!,
    onChange(elements, session) {
        render(elements, session);
    },
});

// Later, when the view goes away.
connection.close();
```

An endpoint and a token are the only inputs. Obtaining the token is somebody else's job:
`rig-connect` never logs in, never reads credentials from disk, and never touches the environment.

The endpoint is any HTTP address serving Rig's protocol; the port above is only an example. Note
that the local daemon currently listens on a Unix domain socket rather than a TCP port, so reaching
it from this library means exposing the protocol over HTTP.

`onChange` fires whenever any element changes, with the current list and the current session state.
`close` releases everything the connection holds and stops all reporting.

`onDelta` is optional and receives ordered notifications for callers that would rather react than
re-render. It always fires after `onChange` for the same update, so a consumer handling a delta
already sees state that reflects it. `onError` reports a failure that ended the connection for
good; ordinary disconnections are not failures and are handled by reconnecting.

## The chat state

The chat state is a flat, time-ordered list of elements. There is one element per message, per
block, and per tool call — a tool call is its own element rather than something nested inside the
message that produced it, so a consumer renders the list in order and never walks a tree.

| Kind            | What it is                                                                    |
| --------------- | ----------------------------------------------------------------------------- |
| `user_message`  | Something the user sent, with any attachments.                                |
| `system_notice` | A non-internal notice Rig intends the person to read.                         |
| `agent_text`    | A block of the model's reply. `complete` is false while it is still arriving. |
| `thinking`      | Model reasoning, when the provider exposes it.                                |
| `tool_call`     | One tool invocation, from streamed arguments through to its result.           |
| `compaction`    | A conversation compaction, reflecting its current state.                      |
| `turn_end`      | The final element of a turn.                                                  |

Every element carries a `turnId`, and every turn ends with a `turn_end` element stating whether it
finished in `success`, `error`, or `stopped`. That is a guarantee the library makes rather than
something a consumer infers from silence: a turn interrupted with a tool still running still gets
its final element, and the open tool call is closed as `interrupted`.

Elements change by delta, not by replacement. Text grows as it is generated, tool-call arguments
fill in as they stream, and a result lands on the tool-call element that was already there.

## Rendering from it

The list is built for React. When it changes, every element that did not change comes back as the
same object, and a new reference appears only where something actually did. A consumer can render
from the list directly and rely on referential equality to skip the rest of the conversation.

Tool calls issued together share a `groupId`, so a burst of calls can be drawn as one coherent unit
instead of a column of unrelated rows.

### Tool presentation

A tool call carries a `presentation`: what the call is doing and what it produced, as an ordinary
application value. A consumer narrows on `kind` and never decodes Rig's wire format.

| Kind             | What it is                                                              |
| ---------------- | ----------------------------------------------------------------------- |
| `command`        | A command Rig ran. Gains `output` when it finishes.                     |
| `exploration`    | Files and searches the tool looked at, as `list`/`read`/`search` steps. |
| `file_edit`      | A diff of the files the tool changed.                                   |
| `terminal_input` | Input sent to a terminal that was already running.                      |

The projection is where the wire format stops. Rig describes a running command and a finished one
as two unrelated shapes; both become one `command` that gains its output, so a UI does not swap one
shape for another halfway through. Where a call and its result disagree, the result wins, being the
later and fuller account.

Exploration steps keep the daemon's own terms — `list`, `read`, `search`, with the target, name,
query, path, and command each reports. Wording is left to the interface, because a sidebar, a
transcript row, and a screen reader describe the same search differently, and none of them can
recover the query once it has been folded into a phrase.

A `kind` this library does not know projects to `undefined` rather than leaking a half-understood
shape, and the call's plain `result` text remains the fallback. That is what lets a newer daemon
talk to an older client. `ToolCallPresentation` and `ToolResultPresentation` remain exported for a
consumer that wants the raw wire values, and `projectToolPresentation` is exported for one driving
the state itself.

## The session state

Separate from the list is one small value answering what the session is doing right now.

```ts
const { activity, git, modelId, tokens, title } = connection.session();
```

`activity.kind` is one of `idle`, `queued`, `thinking`, `generating_message`,
`generating_tool_call`, `executing_tool_call`, `awaiting_input`, `compacting`, `retrying`,
`stopped`, or `error`, and `activity.label` is ready to display. A status line renders from this
without walking the list.

The session state also carries the live facts a complete conversation surface renders: project and
worktree identity, model catalog and locking, effort and service tier, permission mode, composer
draft, recap, pending steering and input requests, tasks, goal, subagents, background processes,
shell commands, permission reviews, context size, and Git changes. Each is initialized by the
opening frame and tracked continuously rather than fetched on demand. `connection` is `connecting`,
`live`, `reconnecting`, or `closed`, so an interruption is a state the subscriber can see rather
than a silent stall.

## The groups

A session does not live alone. Above it is a project, and inside a project are worktrees; both hold
sessions. `connectGroups` keeps that whole tree current from one stream.

```ts
import { connectGroups } from "@slopus/rig-connect";

const groups = connectGroups({
    endpoint: "http://127.0.0.1:4517",
    token: process.env.RIG_TOKEN!,
    onChange(projects, state) {
        render(projects, state);
    },
});
```

Each entry is a project with its worktrees and its sessions already joined and ordered, so no
client repeats that work:

```ts
for (const group of groups.projects()) {
    group.name; // application-shaped project fields, not a wire object
    group.usage.totalTokens; // aggregate usage across the project's sessions
    group.git?.changedFiles; // live Git state, when the daemon is watching it
    group.sessions; // sessions in the project root
    group.workspaces; // worktrees, each with its own sessions and Git state
}
```

The opening frame contains every unarchived session, project, and worktree. Catalog sessions are
not paged; only transcript history is. Archived session history is filtered by the storage query
before the opening snapshot is projected.

The tree is referentially stable in the same way the element list is: a project whose subtree did
not change comes back as the same object, so a React consumer re-renders only the branch that
actually moved.

Two details are worth knowing. Sessions and projects are merged by an ordered identity rather than
by arrival, so a snapshot racing a live event cannot make the view go backwards. And an archived
session leaves the tree while remaining known, so restoring it puts it back rather than requiring a
reconnect.

## The protocol

Everything above is reachable through one continuous stream of events. That is the design
constraint, not an optimization.

The library opens `GET /sessions/:id/stream` with a bearer token and reads Server-Sent Events.

**The first frame is `hello`,** and it is what makes attaching a single request. Connecting without
a cursor, it carries the live facts, the current activity, the assistant message the model is
part-way through generating, and a bounded window of the transcript. Committed transcripts exclude
in-flight messages, so without that third part a client attaching mid-turn would show nothing until
the message completed.

**The transcript window is measured in turns, not messages.** It carries the most recent
`SESSION_STREAM_TURN_LIMIT` turns, currently 20, together with the boundaries and outcome of each
one. Cutting on turn boundaries is what keeps the window honest: half a turn is not a shorter
answer but a broken one, since a tool result whose call was trimmed away has nothing to attach to.
Because turns vary in length, so does the message count — a window of short replies is small, and a
single long run of tool calls can fill it alone. The bound follows the conversation's own structure,
so the cost of attaching tracks recent activity rather than the age of the session.

Those reported boundaries are also what let history render like live output: each finished turn in
the window is replayed with its real duration and outcome, so a turn read from history ends in the
same `turn_end` element a client watching live would have seen.

When the conversation began before the window, `session.transcriptComplete` is `false`. A UI that
scrolls back past it needs a paging call — a deliberate exception to the rule below, and the only
one.

**After that come session events,** each carrying what changed and enough content to apply it.
Nothing is a bare notification that something changed, so there is no polling loop and no fan-out
of requests after each event.

The events the library interprets are `session_activity_changed`, `session_context_changed`,
`session_git_changed`, `session_configuration_changed`, `session_title_changed`,
`message_submitted`, `run_started`, `agent_event`, `agent_message`, `run_finished`, `run_error`,
`session_reset`, and `session_rewound`. Rig emits more than these; anything unrecognised is ordered
and cursored like the rest and then ignored, so a daemon that gained an event does not break a
client that has not learned it yet.

### Reconnection

Every event carries an ordered UUIDv7 identifier. The library remembers the last event it actually
delivered to the subscriber and resumes from it with `?after=`, so a dropped connection produces no
gap, no duplicate, and no reordering that the subscriber can observe.

The `hello` frame is current state rather than a logged event, so it never becomes the cursor. On
resume it omits the session — the caller already has the transcript, and the event log replays the
rest — and carries only what the log cannot reproduce.

Reconnection is automatic, with a backoff that starts at 50ms and grows to a five-second cap. A
response the daemon refuses is not retried: retrying it unchanged cannot help, so it surfaces as a
`SessionStreamRefused` through `onError`.

## Protocol types

The protocol types this library reads are declared in `sources/protocol.ts` rather than imported,
so a browser bundle carries no daemon code. `tests/protocolConformance.test.ts` asserts those
declarations against the daemon's own types, which means a drift between them is a failed
type-check rather than a runtime surprise. Run it with `pnpm check`.

## Layers

`connectSession` and `connectGroups` are the public surface, and most callers need nothing else.
The pieces beneath them are exported for consumers that want to supply their own transport or drive
the state directly:

- `ChatStore` applies protocol events to the element list and the session state, and knows nothing
  about transport. The same store is driven by a live stream, by a replay in a test, or by a
  reconnect.
- `projectToolPresentation` turns Rig's call and result presentations into the one application
  value a `tool_call` element carries.
- `GroupStore` does the same for the project tree: it joins projects, worktrees, and sessions,
  merges by ordered identity, and knows nothing about transport.
- `streamSessionEvents` and `streamGlobalEvents` follow a stream with cursor-based resume, and
  report frames to callbacks.
