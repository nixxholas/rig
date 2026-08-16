# User input

`UserInputModule` gives an agent one common `request_user_input` tool for asking a human a
question and waiting for the answer. The module owns its request table in the Agent Base database.
A host supplies only a narrow external wait broker.

```ts
import { UserInputModule } from "@slopus/happy-agent-modules";

const userInput = new UserInputModule({
    broker, // external durable wait broker
    presence, // optional { state(ctx, agentId), subscribe(ctx, agentId, callback) }
});
```

Each create and settlement transition uses `ctx.inTx`; storage reads and writes the database facade
on `ctx.db`. stdlib `afterCommit(ctx, callback)` registers post-commit event delivery against the
outermost Agent Base transaction. The broker's `wait` method may suspend across daemon restarts;
UserInputModule never holds a database transaction open while it waits.

Requests contain one to four related questions, each with an optional short header and labeled
choices, plus bounded Markdown context. They have a discriminated outcome: `pending`, `answered`,
`cancelled`, `away`, or `timed_out`. Answer payloads can be free-form text or structured selected
labels plus text; batched requests settle with one answer map. Answer, cancellation, timeout, and
away transitions are single-settlement operations.

The `request_user_input` and `cancel_ask` tools never enter Auto-mode review. The request tool is
non-durable because its external wait can outlive a tool execution. It accepts an optional
`autoResolutionMs` window from 60 to 240 seconds for questions where the model may continue with
its best judgement. `cancel_ask` accepts `requestId` (and the legacy `ask_id` spelling) plus an
optional reason. Agent Base's stable call ID is the request ID. The tool creates or resumes that
request in one transaction, then waits through the broker outside a transaction. After a terminal
result, the same tool can read bounded detail pages by request ID and cursor so long answers remain
available to the model.

Host callers can use `ask`, `wait`, `listPage`/`list`, `get`/`getPage`, `answer`, `cancel`, and
`complete`. `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`, and
`formatUserInputForModel` provide the same bounded model-facing rendering for host reuse.
List pages carry the absolute source `cursor` of their first returned row; `nextCursor` is always
computed from that position and the rows actually shown.

Cross-agent reads and settlement are denied by default. An injected authorization policy may grant
specific actions; self-access is always allowed. A presence policy may provide a per-state
`answerWaitMs`, presence guidance, and a subscription for changes while a wait is in flight.
Immediate-away and timeout results include that guidance so the model is told to continue with its
best judgement and can withdraw the Inbox request with `cancel_ask`. With no policy, the host wait
is used directly.
