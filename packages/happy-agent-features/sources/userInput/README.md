# User input

`UserInputFeature` gives an agent one common `request_user_input` tool for asking a human a
question and durably waiting for the answer. The feature owns no inbox UI, transport, timer, or
storage. A host supplies a `UserInputStore` backed by its durable database and wait broker.

```ts
import { UserInputFeature } from "@slopus/happy-agent-features";

const userInput = new UserInputFeature({
    store, // UserInputStore: rows, receipts, proofs, transactions, and durable wait
    presence, // optional { isAvailable(ctx, agentId) }
});
```

The store's `transaction` serializes each ask, answer, cancel, complete, and wait settlement.
`afterCommit` registers post-commit event delivery against the host's outermost transaction. The
store's `wait` method may suspend across daemon restarts; UserInputFeature never holds a store
transaction open while it waits.

Requests contain a short question and bounded Markdown context, optional labeled choices, and a
discriminated outcome: `pending`, `answered`, `cancelled`, `away`, or `timed_out`. Answer payloads
can be free-form text or structured selected labels plus text. Answer, cancellation, timeout, and
away transitions are single-settlement operations.

The tool is durable and never enters Auto-mode review. Its ask input contains only the question,
Markdown context, choices, and optional deadline; feature-owned mutation identities stay in the
call-scoped AgentKV. After a terminal result, the same tool can read bounded detail pages by
request ID and cursor so long answers remain available to the model. Retrying the same durable
call re-attaches to its stored request. Direct host-facing mutations must supply their
caller-owned operation ID; host ask retries recover the request identity from the durable receipt
boundary.

Host callers can use `ask`, `wait`, `listPage`/`list`, `get`/`getPage`, `answer`, `cancel`, and
`complete`. `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`, and
`formatUserInputForModel` provide the same bounded model-facing rendering for host reuse.
List pages carry the absolute source `cursor` of their first returned row; `nextCursor` is always
computed from that position and the rows actually shown.

Cross-agent reads and settlement are denied by default. An injected authorization policy may grant
specific actions; self-access is always allowed. An injected presence policy can settle a pending
wait as `away`; with no policy, the host wait is used directly.