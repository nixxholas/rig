# Master plan 1: `rig-connect`

## Big picture

Every Rig user interface — the terminal, the web app, a mobile client, anything
we build later — should get the live state of a session by embedding one small
library and subscribing to one thing. That library is `rig-connect`.

Today a client that wants to show a conversation has to do the work itself: open
the session stream, follow the updates, fetch what it is missing, and reassemble
a transcript. Every UI ends up reimplementing the same fragile reconstruction,
and every UI pays for it in bugs.

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

History loads by turns, and it can load backwards. It must also load from the
middle, so that on restart a client opens a chat exactly where the user left
off, however large the chat is. Chats are assumed to be colossally huge — a
chat may run for months or years — and all of them must be supported.

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

The protocol always rests on two mechanisms: request-response, and an ephemeral
stream of updates. Sync is the two working together, and each carries only what
it is good at.

- **The stream is a queue of light events.** The daemon keeps an in-memory queue
  of events to send to clients, each numbered with a strictly monotonic id — a
  UUIDv7, so they always sort. When a client connects it receives the current
  cursor, and from then on a guaranteed continuous stream.
- **Resume is a cursor.** After a drop, the client reconnects with the id of the
  last event it received. The daemon keeps a small in-memory cache — on the
  order of a thousand events — and either replays from that cursor, or answers
  with the current cursor and reports that a gap was detected. A gap is not an
  error; it tells the client to re-fetch what it holds.
- **Durable and non-durable may be two endpoints.** The durable events must stay
  as they are. Whether durable and non-durable events actually differ is not
  known; if the durable updates can simply be served non-durably, that would
  most likely be enough for everything. Possibly there are just two endpoints —
  one durable, one non-durable — carrying the same events, except the
  non-durable one may report that something was lost.
- **One subscription, exactly.** Every local client uses one single global
  subscription; there is no session-scoped stream. A terminal subscribes to
  the same global stream and filters it down to the session it is showing.
  Rewrite the events so that one subscription is enough for everything, and a
  client — Rig Connect in particular — can load anything. The global event
  stream must be implemented and working.
- **No backward compatibility, except two things.** Compatibility with the
  existing reconnect is not needed at all. The durable events and the terminal
  must be preserved.
- **No large packets.** Updates are light and tidy. Messages appear in the
  stream as they are — they belong there. Session objects, group objects,
  workspace objects, project objects, and user objects are never sent inside
  an update: they would otherwise repeat identically a hundred times over,
  and they change far more rarely than messages do.
- **One event may carry several facts.** An update can relate to more than one
  session, and one event can state two things at once: a final message that
  completes a session in a particular state is one event, not two. Facts are
  split into separate events only when they can genuinely happen at different
  times — a final message can arrive without ending the session. Ideally,
  maybe, a flag tells the client whether it did; something flexible along
  those lines. The reason is the interface: it must update in one frame, from
  one update, not from many. When the final message arrives, the client hides
  the cursors, appends the last message, and marks it finished — all in a
  single frame from a single update, not a burst of them.
- **Request-response carries the entities.** A client loads users, agents,
  sessions, workspaces, projects, and the rest by asking for them. The other
  entity-fetching methods most likely exist already.
- **Loading is flexible, but not too complex.** Loading projects, for
  instance, can ask for only the active ones, only the inactive ones, or a
  specific list of ids. The same request can include or leave out the
  workspaces inside them, and within those workspaces fetch the sessions in
  that one request or not — active ones or all of them, the same choice
  again. The API stays at simple filters and simple modifications of the
  request, so a client asks for exactly what it needs at that moment. At
  application start it most likely loads everything; on a change or a
  reconnect it probably refreshes the session it is looking at first, then
  everything else. The client must be able to choose later what it needs,
  and to optimize what turns out not to be optimal. It should probably be a
  POST, returning some subset of what needs loading — a session that has
  dropped out of the catalog because it became archived, for instance.
- **Every entity states its identity and its version.** Identity is a cuid2, as
  today. The version is the UUIDv7 id of the last event that touched the
  entity — what `session.lastEventId` already is. Two views of the same entity
  merge by comparing versions, never by guessing which is newer.
- **Each entity has something like a mini-queue and a snapshot.** Events from
  before the snapshot are deleted; everything after it is applied — probably in
  some clever way, exactly how is not settled. Track the event id that was
  current at the moment the snapshot was loaded, and when the snapshot itself
  was last changed. That determines unambiguously whether an event must be
  applied or not, because events are assumed to enter the system strictly
  sequentially, with nothing lost.
- **Fetch once, then follow.** An update tells a client that something changed.
  The client fetches the entity by request-response and from then on keeps it
  synchronized live over the SSE connection.
- **Very simple, in order.** The protocol must be very simple. First, load the
  initial state — that could be done synchronously, or some other way. Ideally
  the events open first and the entities load after, so they can always be
  rebased. From then on everything synchronizes in real time with exponential
  backoffs — relatively short ones, though.
- **A mutation carries its own identity.** A client changes its state locally
  and sends the command; when Rig's version of that change arrives on the
  stream, the client has to recognise it as the echo of its own action rather
  than applying it a second time.

All of this is live sync for local client sessions, nothing more — it is not the
durable event queue. And because everything is local for now, the rare case
where a client must re-fetch everything is allowed to stay simple; it is not
worth engineering around. The result should be the lightest, tidiest
synchronization we can build.

## Requirements

1. **Fast.** New state reaches the subscriber as soon as the daemon knows it.
   Nothing waits on a poll interval.
2. **Cheap on the wire.** Updates are small, and there are no large packets.
   Entity objects never travel inside the stream; they travel by
   request-response. This is about ordinary live sync for terminals and other
   UIs; the durable event queue is a separate concern.
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

**A. Build the protocol.** Two mechanisms: request-response for entities, and
the ephemeral stream of light updates with its UUIDv7 cursor, its small replay
cache, and its honest gap report. One global subscription for every local
client; a terminal filters it down to the session it is showing. Loading
methods take simple filters, so a client asks for exactly what it needs.
Groups are part of this step, not a later addition. Done when a client can
connect, receive the current cursor, follow a continuous stream, resume after
a drop or learn that a gap was detected, load entities over request-response,
and keep everything it holds current from the stream.

**B. Build the package.** `rig-connect` connects, loads the entities it needs,
follows the stream, maintains the element list and the session state, applies
presentation and grouping, applies mutations optimistically and delivers them in
the background, and exposes the subscription, the actions, and the deltas. Done
when the turn guarantee, the ordering, and the reference stability hold under
test, including across reconnects and interruptions, and when a mutation
survives a reconnect, a rejection, and a competing update without leaving the
interface showing something untrue.

**C. Move the clients onto it.** The terminal and the web UI read their session
state through `rig-connect` and delete their own reconstruction logic. Done when
no UI in the repository interprets session events on its own.

## Criteria for the whole plan

- One implementation of sync in the product.
- A UI subscribes to the library once and renders; the fetching and following
  behind that view is the library's problem, not the interface's.
- Every action lands instantly, and the network is something the user never
  waits on except to load more.
- The library runs identically in Node and in a browser.
