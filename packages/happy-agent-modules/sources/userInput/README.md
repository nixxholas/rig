# User input

`UserInputModule` gives an agent one common `request_user_input` tool for asking a human a
question and durably waiting for the answer. The module owns only its request table. A host
supplies the storage adapter and a narrow external wait broker.

```ts
import { UserInputModule } from "@slopus/happy-agent-modules";

const userInput = new UserInputModule({
    store, // request rows and transactions
    broker, // external durable wait broker
    presence, // optional { isAvailable(ctx, agentId) }
});
```

The store transaction serializes each ask, answer, cancel, complete, and wait settlement.
stdlib `afterCommit(ctx, callback)` registers post-commit event delivery against the outermost
AgentStorage transaction. The broker's `wait` method may suspend across daemon restarts;
UserInputModule never holds a database transaction open while it waits.

Requests contain a short question and bounded Markdown context, optional labeled choices, and a
discriminated outcome: `pending`, `answered`, `cancelled`, `away`, or `timed_out`. Answer payloads
can be free-form text or structured selected labels plus text. Answer, cancellation, timeout, and
away transitions are single-settlement operations.

The tool is durable and never enters Auto-mode review. Its ask input contains only the question,
Markdown context, choices, and optional deadline. Agent Base's stable call ID is the request ID.
The tool creates or resumes that request in one transaction, waits through the broker outside a
transaction, then settles the call with `call.commit` in one transaction. After a terminal result,
the same tool can read bounded detail pages by request ID and cursor so long answers remain
available to the model.

Host callers can use `ask`, `wait`, `listPage`/`list`, `get`/`getPage`, `answer`, `cancel`, and
`complete`. `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`, and
`formatUserInputForModel` provide the same bounded model-facing rendering for host reuse.
List pages carry the absolute source `cursor` of their first returned row; `nextCursor` is always
computed from that position and the rows actually shown.

Cross-agent reads and settlement are denied by default. An injected authorization policy may grant
specific actions; self-access is always allowed. An injected presence policy can settle a pending
wait as `away`; with no policy, the host wait is used directly.
