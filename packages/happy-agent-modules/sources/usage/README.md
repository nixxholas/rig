# Usage

Advisory token and timing accounting for one agent, and for the collection it belongs to. It
answers "how much has this agent cost so far" without becoming a quota system: the module owns
one bounded record table, and a failure to record a number never fails a turn or an inference.
Lifecycle records join Agent Base's existing completion transactions instead of opening their own.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { UsageModule } from "@slopus/happy-agent-modules";

const usage = new UsageModule();
const agent = await Agent.create(ctx, { ...options, modules: [usage] });
```

One instance serves every agent in a collection. The module owns its tables and uses the database
carried by the current context.

## Tools

### `get_usage`

Reads bounded usage for the calling agent only. Cross-agent and whole-collection reads are a host
API, never something a tool argument can request.

Arguments (`GetUsageInput`):

- `aggregate?: boolean` — present for symmetry with the host aggregate query; the tool always
  returns an aggregate summary regardless of its value.
- `target?: string` — must equal the calling agent's ID if given; any other value throws
  `"Usage can only be read for the current agent."` before the store is touched.
- `cursor?: number`, `maxGroups?: number` — forwarded to `UsageModule.read` to page through
  provider/model/effort/tier groups.

The tool is `durable: true` and declares `shouldReviewInAutoMode: () => false`, so it never needs
Auto review — it only reads. It calls `module.read(ctx, agentId, query)` and returns a
`UsageSummary`. `toLLM` renders the summary through `module.formatForModel`, which is a compact,
strictly bounded text block: header line, four running totals, then one line per visible group,
each admitted only if the whole candidate output still fits the character budget
(`MAX_USAGE_OUTPUT_CHARACTERS`, default 8,000). If the model asked for more than fits, the last
line names the continuation cursor to call `get_usage` with again — `formatForModel` never returns
a truncated group row, only a note of what to page for next.

## External functions

`UsageModule` exposes these methods for hosts and other callers (all take a `Context` first):

- `read(ctx, agentId, query?)` / `readAgent` / `readAgentUsage` — the per-agent aggregate; `query`
  accepts `cursor` and `maxGroups`, bounded by `maxPageSize`/`maxGroups` from the constructor
  options. Throws if the context's own `agentId` (via `contextAgentId`) doesn't match `agentId`.
- `readPage(ctx, agentId, query?)` — one bounded page of raw `UsageRecord`s (`cursor`, `limit`),
  for a host that needs provider/model detail rather than totals.
- `aggregate(ctx, query?)` / `readAggregate` / `readAggregateUsage` — a bounded summary for one
  agent (`query.agentId` set) or the whole collection (`query.agentId` omitted). Only reachable
  from a non-agent context; an agent-scoped `ctx` cannot ask for the whole collection.
- `reset(ctx, agentId)` / `resetAgentUsage` — deletes one agent's records and returns the
  number removed.
- `resetAll(ctx)` / `resetAggregateUsage` — resets the whole collection.
- `formatForModel(summary, maxCharacters?)` — the same bounded renderer the tool uses, exposed so a
  host can produce the same text outside a tool call.

`UsageModuleListener` (constructor option `listener`) is notified of every committed mutation as a
`UsageEvent` — `usage_recorded` or `usage_reset` — through `onEventTransactional` (inside the
store's transaction) and `onEvent` (after commit, best-effort: a throwing `onEvent` is reported via
`onObserverError`, not propagated).

`beforeInferenceTransact`, `beforeTurnTransact`, `afterInferenceTransact`, and
`afterTurnTransact` are Agent Base lifecycle hooks, not host-facing calls. Base's stable
`inferenceId` and `turnId` become the corresponding usage record IDs.

## Storage

The module keeps almost nothing itself. Two kinds of state exist:

**Run KV** (`scope.runKV`, scoped to the active run): the start time of the current inference and
turn, written by the before hooks and deleted by the matching completion hooks.

- Key `pending_inference` — `{ startedAt: UsageTimestamp }`
- Key `pending_turn` — `{ startedAt: UsageTimestamp }`

The identities come from Agent Base rather than module-owned replay state.

**Module-owned table** (`happy_agent_usage_records`): durable records and bounded aggregates.
Migration `002-drop-usage-reset-receipts` removes the obsolete reset-receipt table created by the
immutable first migration.

- `record(ctx, UsageRecord)` inserts one record (`usage_inference_record` or `usage_turn_record`),
  keyed by Base's `inferenceId` or `turnId` and attributed by
  `agentId`/`provider`/`model?`/`effort?`/`tier?`.
- `read(ctx, agentId, { cursor, limit })` returns a bounded `UsagePage` (`records`, `cursor`,
  `totalRecords`, `nextCursor?`), capped at `MAX_USAGE_PAGE_SIZE` (100) per page and
  `MAX_USAGE_RECORDS` (500) records overall.
- `aggregate(ctx, { agentId?, cursor, maxGroups })` returns a `UsageSummary`: running totals
  (`inferenceCount`, `turnCount`, token and duration sums) plus a bounded, paged array of
  `UsageGroup` rows (one per provider/model/effort/tier combination), capped at `MAX_USAGE_GROUPS`
  (500) groups.
- `reset(ctx, agentId | null)` deletes matching records and reports how many were removed.
- The host transaction is the single read/decide/write boundary every mutation runs inside, and
  stdlib `afterCommit(ctx, callback)` registers post-commit event delivery inside that same
  transaction.

Every value crossing this boundary is checked against its TypeBox schema. Token counts, durations,
and timestamps are bounded (`MAX_USAGE_TOKEN_COUNT`, `MAX_USAGE_DURATION_MS`,
`MAX_USAGE_TIMESTAMP`), and a record whose `durationMs` doesn't equal `finishedAt - startedAt`, or
whose timestamps run backwards, is rejected before it reaches the store.
