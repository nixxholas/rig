# Master plan 1: `rig-connect`

## Big picture

Every Rig user interface — the terminal, the web app, a mobile client, anything
we build later — should get the live state of a session by embedding one small
library and subscribing to one thing. That library is `rig-connect`.

Today a client that wants to show a conversation has to do the work itself: open
the session stream, learn from an event that _something_ changed, then issue more
HTTP requests to find out _what_ changed, and finally reassemble a transcript.
The events are notifications, not data. Every UI ends up reimplementing the same
fragile reconstruction, and every UI pays for it in latency, requests, and bugs.

`rig-connect` replaces that with a single correct implementation: it connects to
a Rig endpoint, keeps a live chat state in memory, and hands it to the UI as an
ordered list plus a stream of meaningful deltas. It is the only place in the
product where sync is reasoned about.

Building it is also how we find out what the sync protocol should be. The
existing protocol is evidence, not a constraint. Where it makes a good client
impossible, change the protocol. The bar is the highest quality we can reach,
not compatibility with what we shipped first.

## What it is

- A new package, `rig-connect`, in `packages/`.
- Input to the caller: an endpoint (URL) and a token. Nothing else. Obtaining
  the token is somebody else's job — `rig-connect` never logs in, never reads
  credentials from disk, never touches the environment.
- No runtime dependency on the `rig` package. Protocol types are embedded in the
  package so a browser bundle carries no daemon code. A type mismatch with the
  daemon must be caught at build time, not at runtime.
- Built on plain Web APIs — `fetch`, streams, `AbortController`, `AbortSignal`,
  standard timers. It runs unchanged in Node, in a browser, and in any runtime
  that provides those. No Node built-ins, no platform branches.

## The chat state

The chat state is a flat, time-ordered list of elements.

- One element per message, per block, and per tool call. A tool call is not
  nested inside the message that produced it; it is its own element.
- Every element carries a turn ID.
- A turn always ends with a final element, and that element states whether the
  turn ended in success or in an error. This is a guarantee the library makes,
  not something the consumer infers from silence.
- Everything between the turn's start and its final element is ordered by time.
- State that is not model output is in the list too, in its time position —
  compaction, for instance, appears as an element and reflects its current
  state.

Elements change by delta, not by replacement. Text arrives as it is generated,
tool-call arguments fill in as they stream, a tool result lands on the element
that was already there. The library applies those deltas; the consumer sees an
element that is simply more complete than it was.

## The session state

Separate from the list, and just as important, is one small value that answers
"what is this session doing right now": idle, thinking, generating a message,
generating a tool call, executing a tool call, compacting, retrying, stopped.
It is a current-moment summary, not history, and a UI should be able to render a
status line from it without walking the list.

The session also carries live facts that a UI shows next to the conversation,
and each of them is tracked continuously rather than fetched on demand:

- the current model, and model switches as they happen;
- the context size;
- the Git state;
- the list of changed files, computed and kept current in real time rather than
  offered as something a client can opt into and poll.

## Groups

A session does not live alone. Above it is a **group**: the folder or the
container that a set of chats belongs to, depending on how Rig was started. A
group is either a workspace or a project, and a project contains workspaces.

A group has state of its own, and that state syncs the same way sessions do:

- **A name.** It may be generated for the group and it may be regenerated as we
  learn more — until the user edits it. A user-edited name is final; nothing
  overwrites it afterwards.
- **A current Git branch**, when the group has a Git repository. Optional, and
  live.
- **Usage**, kept current continuously.

Rig already knows all of this. What is missing is a clean way to sync it.

## Presentation

The raw stream is not what a UI wants to draw. `rig-connect` does the
preprocessing once, so no client repeats it:

- Tool calls carry their presentation — the human-readable rendering of what the
  tool is doing and what it produced — and that presentation updates in place as
  the tool progresses.
- Related tool calls are grouped when they belong together, so a UI can draw one
  coherent unit instead of a burst of rows.

The result must be shaped for a normal application: stable identities, ordinary
values, nothing that requires the consumer to understand the wire format.

## Mutations

Reading is half of what a user interface does. It also archives a session,
renames a group, switches a model, sends a message, stops a run. Those go
through `rig-connect` as well, and every one of them is optimistic.

An action takes effect the instant it is taken. Archiving a session hides it and
disables everything it owns immediately: the row leaves the list, its controls
stop responding, its conversation closes. Only then does the command travel to
the daemon, in the background, retried with backoff until it lands. Nobody waits
on a round trip to see a decision they already made, and no control sits inert
after being used.

The daemon stays authoritative. An optimistic change is a prediction of what it
will say, superseded the moment the real state arrives, through the same
ordered-identity merge that reconciles any two views of an entity. A prediction
that turns out wrong is corrected on screen. A prediction that cannot be
delivered at all is reverted and reported. What must never happen is a change
that quietly disappears, or one that lingers after Rig has rejected it.

Delivery is the library's problem, not the interface's. A pending mutation
survives a reconnect, retries with backoff, and holds its order against other
mutations of the same entity — sending them out of order would let a stale
intent win.

Loading is the one exception. Fetching earlier turns, or the rest of a long
session list, has genuinely nothing to show until it arrives. That may present a
loading state. Nothing else may.

## The public surface

One function to subscribe to changes of that list, and actions that change it.
That is the surface. An action returns as soon as the local state reflects it;
it never hands back a promise the caller has to await before drawing.

It is built for React. When the list changes, unchanged elements keep their
identity: the same reference comes back for anything that did not change, and a
new reference appears only where something actually did. A consumer can render
from the list directly and rely on referential equality to avoid re-rendering
the rest of the conversation.

Alongside the list, the library emits deltas about local state: a message
changed, compaction started, compaction finished, a retry started, a retry
finished, the session started, the session stopped. These correspond to things
the protocol already reports, but here they arrive with a guarantee — queued,
ordered, and not lost across reconnects.

## How the protocol works

Everything above must be reachable through one continuous stream of events. That
is the design constraint, not an optimization.

- **The stream is sufficient.** A client follows events and stays correct. There
  is no repeated "get the difference" call, no polling loop, no fan-out of
  requests after each notification. Whoever implements the protocol today makes
  far too many requests, and that is exactly the outcome we are removing.
- **Groups are complete.** The opening frame always carries every unarchived
  project, workspace, and session. These lists are not paged and never need a
  load-more action.
- **Difference is a recovery path.** Asking for a difference exists only for the
  case where a client has genuinely lost its state and Rig can no longer produce
  a delta from memory. It is the exception, and it should be rare enough to
  notice.
- **Every payload is complete.** Each event, each object, each response carries
  what a client needs to act on it. Nothing is a bare notification that
  something changed.
- **Everything merges by an ordered identity.** Several streams and requests run
  in parallel, so a client must be able to combine two views of the same entity
  without guessing which is newer. Every entity and every event carries an
  identifier bound to time or version. We already use ordered UUIDv7 identifiers
  and ordered events; continue with that rather than inventing a second scheme.
- **A mutation carries its own identity.** A client changes its state locally and
  sends the command; when Rig's version of that change arrives on the stream, the
  client has to recognise it as the echo of its own action rather than applying
  it a second time.

## Requirements

1. **Fast.** New state reaches the subscriber as soon as the daemon knows it.
   Nothing waits on a poll interval.
2. **Cheap on the wire.** An event carries what changed. A client must not have
   to issue follow-up requests to interpret an event it just received. This is
   about ordinary live sync for terminals and other UIs; the durable event queue
   is a separate concern.
3. **Cheap on the machine.** The library must not hold resources it does not
   need: bounded memory, no unbounded buffers or promise chains, no busy work
   when nothing is happening, everything released on unsubscribe. This is the
   inverse of the usual scalability requirement — the goal is to be small and
   quiet, not to absorb load.
4. **Reliable.** Reconnects resume rather than restart. No gaps, no duplicates,
   no reordering visible to the subscriber. Interruption is a state the
   subscriber can see, not a silent stall.
5. **Correct under React.** Stable references, stable identities, no tearing
   between the list and the deltas.
6. **Instant.** Every mutation applies locally at the moment it is made, and the
   round trip happens behind it. Delivery, retry, ordering, and reconciliation
   are the library's job. Loading more is the only thing allowed to make anyone
   wait.

## The steps

**A. Design the protocol we actually want.** Rebuild the session stream around
what a client needs: self-describing events that carry what changed and enough
content to apply it, deltas for growing elements, and the current session state.
Replace what does not serve that. Groups are part of this step, not a later
addition. Done when a client can build a complete transcript, an accurate
session status, and current group state from the stream alone, without a single
follow-up request beyond the initial snapshot.

**B. Build the package.** `rig-connect` connects, snapshots, follows the stream,
maintains the element list and the session state, applies presentation and
grouping, applies mutations optimistically and delivers them in the background,
and exposes the subscription, the actions, and the deltas. Done when the turn
guarantee, the ordering, and the reference stability hold under test, including
across reconnects and interruptions, and when a mutation survives a reconnect, a
rejection, and a competing update without leaving the interface showing
something untrue.

**C. Move the clients onto it.** The terminal and the web UI read their session
state through `rig-connect` and delete their own reconstruction logic. Done when
no UI in the repository interprets session events on its own.

## Criteria for the whole plan

- One implementation of sync in the product.
- A UI subscribes once and renders; it never asks the daemon a follow-up
  question to understand what it was just told.
- Every action lands instantly, and the network is something the user never
  waits on except to load more.
- The library runs identically in Node and in a browser.
