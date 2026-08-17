# History

The agent's own record of what happened, which it can read back. This is not the model's context:
the context is what the provider is replaying right now, and it is compacted, reset, and thrown
away as the conversation moves. The history is what was said and done, kept whether or not any
model can still see it — so a conversation reset by an incompatible model switch loses its context
entirely and loses none of its history.

The module writes as the agent works: every accepted user message, every completed assistant
response, every tool result, and every failed inference, from inside the transactions that commit
that work, so the record and the thing recorded become durable together.

The record keeps who actually sent each incoming message. Provider input shapes only have user
and assistant roles, so goal continuations, collaboration deliveries, and other system-generated
messages all reach the model wearing the user role; the history records them under their real
sender instead. A message the host positively stamped as an end-user submission (the same
`messageOrigin` provenance metadata the automatic permission reviewer trusts) is recorded as
`role: "user"`; everything else, including an unstamped message, is recorded as `role: "agent"`,
with `senderAgentId` naming the specific sending agent when its metadata named one — the
collaboration module names the sending collaborator, and a goal continuation names the agent
driving itself. This fails closed: a forgetful path under-attributes rather than a synthetic
message being recorded as the person.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryModule } from "@slopus/happy-agent-modules";

const history = new HistoryModule();
const agent = await Agent.create(ctx, { ...options, modules: [history] });
```

Any agent may read any agent's history. `HistoryModuleOptions` accepts `resolveTarget`, a
callback the host provides to map canonical session-tree paths to Agent IDs (it may raise its
own ambiguous-path error); a target the host does not recognize is read as a raw Agent ID, and a
target that exists nowhere simply has an empty archive. `listAgents` supplies the bounded session-tree
summaries returned with every tool response; without it, self-history still reports the current
agent with its archive count. `toolDisplay` optionally supplies the one-line summary that the host
would show for a tool result. When it is absent, lifecycle recording uses a bounded generic
success/error summary. `toolOutputLimit` controls how many characters of a tool's output are worth
recording (default `16_000`, separate from `MAX_HISTORY_TOOL_OUTPUT_LENGTH`, the hard persistence
cap). `failureMode` defaults to `"propagate"`: an archive failure rolls back the Agent Base
transaction it happened inside. Passing `"best-effort"` is an explicit opt-in for hosts that treat
history as advisory; a store failure is then swallowed and the record is dropped.

## Tools

### `read_agent_history`

The only tool the module exposes. It reads or searches the durable history for the calling agent,
or for any other agent when `target` is given — history is readable by every agent.
Reading changes nothing and reaches nothing outside the agent's own store, so the tool is
`durable: true`, `transactional: true`, and `shouldReviewInAutoMode` always returns `false` —
there is nothing to review. Agent Base owns the page-read and result transaction.

Arguments:

- `cursor` — a zero-based original history position, taken from a previous `next_cursor` or
  `previous_cursor`. Cannot be combined with `from`.
- `from` — `"start"`/`"begin"`/`"beginning"` for the first matching page, `"end"`/`"last"` for the
  last one. Results are always returned chronologically regardless of which end was asked for.
  Cannot be combined with `cursor`.
- `limit` — the most matching messages to select before the response is cut by size. Defaults to
  100, capped at `MAX_HISTORY_PAGE_SIZE` (500).
- `query` — case-insensitive text search over the whole stored message: text, thinking, tool
  names, tool arguments, and tool output — not just what a bounded rendering would show.
- `roles` — restrict to up to five of `"user"`, `"agent"`, `"assistant"`, `"error"`, `"system"`.
- `include_tools` — include simplified tool calls and truncated tool results in the rendering.
  Defaults to `true`; it never changes what `query` searches.
- `target` — a Stable Agent ID or canonical session-tree path such as `/root/audit`. Omitted means
  the caller; paths are resolved by the host, and a value the host does not recognize is read as a
  raw Agent ID.

The response always includes `agents`, the bounded session-tree roster with `agent_id`,
`description`, `message_count`, `path`, and `status`, so a model can discover targets before
reading them. The response is a rendering, not a replay: `history` is chronological text capped at 80,000
characters (`MAX_HISTORY_CHARACTERS`), one numbered block per message, with long text truncated,
tool arguments and output truncated separately and more tightly, images represented only by media
type, and reasoning the provider hid marked `[redacted]` rather than fabricated. Because the cap is
on characters rather than message count, a requested `limit` can come back with fewer messages than
asked for; `returned_messages`, `cursor`, `next_cursor`, and `previous_cursor` say exactly what was
covered and how to continue. `matched_messages` and `total_messages`, and the three `stats` blocks
(`matched`, `returned`, `total` — assistant/user message counts, text characters, thinking blocks,
tool calls, and tool results), let the model size what it did and did not see without reading it.

## External functions

- `record(ctx, agentId, message: HistoryMessageInput): Promise<void>` — append one message on the
  host's behalf, for anything the module itself did not observe. The module allocates `recordId`
  and `at` when the input omits them.
- `read(ctx, agentId, query?: HistoryQuery): Promise<HistoryPage>` — one page, filtered and paged
  exactly the way the tool sees it. This is what `read_agent_history` calls internally.
- `messages(ctx, agentId, { from?, limit? }): Promise<HistoryRecord[]>` — the raw records for a
  page, without the tool's text rendering, for a host that wants to build its own view.
- `stats(ctx, agentId): Promise<HistoryStats>` — exact totals for the whole archive, read through
  the store's bounded page operation rather than derived from a sampled page, since a caller such
  as model handoff may keep only a two-ended sample while still needing the true totals.
- `listAgents(ctx, requesterAgentId, targetAgentId?): Promise<HistoryAgentSummaries>` — the bounded
  related-agent roster supplied by the host, or a self/target fallback when no roster adapter is
  configured.
- `resolveTarget(ctx, requesterAgentId, requestedTarget): Promise<string>` — the resolution behind
  the tool's `target` argument. Requesting one's own ID always resolves; anything else is offered
  to the constructor's `resolveTarget` (which maps canonical paths and may raise its own
  ambiguous-path error), and a target it does not map is used as a raw Agent ID as long as it is a
  well-formed one.

The module also implements the `AgentModule` lifecycle hooks that do the recording:
`onEventTransact` (buffers each completed text/thinking/tool-call block), `messageAcceptedTransact`
(records an accepted user message), `beforeToolCallTransact`/`afterToolCallTransact` (record one
tool result per call, including its one-line display summary), `afterInferenceTransact` (writes the
finished response and, if inference failed, a separate `role: "error"` message), and
`afterAgentSettledTransact` (flushes any response blocks still pending after an interruption).
These are not meant to be called directly by a host.

## Storage

Completed history lives in the module's migrated database table. Agent lifecycle hooks use the
transaction already supplied by Agent Base; direct host operations use the constructor's
`transaction` integration. `recordId` identifies a record, and reusing one is a database conflict,
not a module-owned replay signal. Agent Base owns durable tool retry and completion. A
`HistoryRecord.position` is the original, stable position at which a message was written; cursors
are positions rather than offsets.

In-flight work — the part of a response not yet durable — is kept only in `scope.runKV`, the
run-scoped Agent KV the Agent Base lends the module, under these keys:

- `pending_blocks` — the array of `HistoryBlock`s (text, thinking, tool calls) accumulated by
  `onEventTransact` since the last flush, up to `MAX_HISTORY_PENDING_BLOCKS` (2,048) entries.
- `tool_name` — the name of the tool currently dispatched, written by `beforeToolCallTransact` and
  read back by `afterToolCallTransact`.

The pending blocks are cleared in the same transaction that appends their message, so a crash
cannot commit only one side. Every message, block, and argument value written to KV or the database
is checked against the
bounds in `HistoryMessage.ts` (per-field lengths, `MAX_HISTORY_BLOCKS_PER_MESSAGE`,
`MAX_HISTORY_MESSAGES_PER_APPEND`, and the overall JSON byte ceilings for a message and for one
tool-argument value) before it is written, so a malformed or oversized value fails the write rather
than being silently truncated or stored.
