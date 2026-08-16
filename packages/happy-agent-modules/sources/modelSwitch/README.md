# Model switch

Switching between incompatible models erases the conversation: their transcripts cannot be
replayed to one another, so `@slopus/happy-agent-base` gives the new model an empty context while
the work the old one did still stands. Left alone, the new model would answer the next message as
though nothing had happened, silently repeating or undoing work it cannot see. This module puts
one system message at the head of that fresh context saying what changed and that a conversation
it cannot see came before, so the model orients itself instead.

A compatible switch — one that keeps the history intact — needs no notice, and none is produced.
Neither does a new agent's first message. An agent that never had a model never held a conversation
either, so its opening selection settles the model rather than replacing one; the base still reports
that as a reset because it discards the empty context, but there is no erased work to inherit.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryModule, ModelSwitchModule } from "@slopus/happy-agent-modules";

const history = new HistoryModule({ store });
const agent = await Agent.create(ctx, {
    ...options,
    modules: [history, new ModelSwitchModule({ history })],
});
```

`ModelSwitchModuleOptions` takes one optional field:

- `history` — a `HistoryModule` reference, the same instance a host also gives its own `modules`
  array. This is a direct reference to the class, not a duck-typed reader and not a tool name a host
  names separately: `ModelSwitchModule` calls `history.messages`/`history.stats` itself, and always
  knows `HistoryModule`'s one tool is `read_agent_history` because that name is fixed, not
  configurable.

Model switching itself never requires a history to behave correctly. Without one, the notice still
tells the new model plainly that an invisible conversation came before and that it must not repeat
or undo work that may already be done — which is honest and sufficient on its own, and is why
`history` is optional rather than required. When it is supplied, the notice additionally carries an
overview and both ends of the erased conversation, bounded, plus a pointer at `read_agent_history`
for anything the excerpt does not cover — so the new model starts by reading what happened rather
than only being told that something did.

## Tools

This module provides no tools of its own. It acts entirely through the `modelChanged` hook on
`AgentModule`, producing a single system-role notice message that `@slopus/happy-agent-base`
inserts at the start of the new model's context. When `history` is supplied, the notice names
`read_agent_history` and tells the model to call it proactively; that tool itself belongs to
`HistoryModule`, not to this one, and a host must add `history` to its own `modules` array
separately for the tool to actually be available to the model.

## External functions

`ModelSwitchModule` is a class implementing `AgentModule`; hosts use it only by constructing it
and passing it into `Agent.create`'s `modules` array. Its hooks:

- `beforeStart(ctx, agents: AgentSystemRef): Promise<void>` — keeps a reference to the agent
  collection, which is where a model's picker label comes from when naming it in the notice.
- `modelChanged(ctx, scope: AgentModuleScope, change: AgentBaseModelChange): Promise<SessionSystemMessage | undefined>` —
  called by the agent base whenever a consumed message changes the effective model. Returns
  `undefined` when `change.wasReset` is false (a compatible switch) and when `change.previousModel`
  is `undefined` (a new agent settling its first selection). Otherwise it builds and
  returns one `{ role: "system", content: [{ type: "text", text }] }` message. `change` carries
  `previousModel`, `model`, `previousProvider`, `provider`, `providers` (the `AgentProviders`
  registry), and `wasReset`.

The package also exports `createModelSwitchNotice(notice: ModelSwitchNotice): string`, the pure
function that renders the notice text from `previousModel`, `previousProvider`, `model`,
`provider`, and the optional `historyTool` and `excerpt` fields. It is exported so hosts and tests
can inspect or reuse the exact wording without going through the module; `ModelSwitchModule`
calls it internally to build the message it returns from `modelChanged`.

Building the notice's excerpt is the module's other main piece of work: when `history` is
supplied, `modelChanged` reads the first and last `EXCERPT_READ_PAGE_SIZE` (100) records via
`history.messages`, validates and merges the two bounded pages, and — when `history.stats`'s counts
are consistent with what was sampled — uses it for an exact aggregate instead of a sampled one. A
failure anywhere in this step (an unreadable history, invalid or unstable records, an over-large
merged result) is caught and simply drops the excerpt; it never fails the switch itself, since
rejecting `modelChanged` would leave the agent stuck on the old model, which is worse than a notice
with nothing quoted. The excerpt text itself keeps the beginning and end of the conversation (4
earliest messages, 8 latest, each message capped at 1,500 characters) within a 32,000-character
budget, since the middle of a long conversation rarely fits and is rarely what matters after a
switch.

## Storage

The module persists nothing itself. It is stateless across calls except for the one in-memory
reference to `AgentSystemRef` captured in `beforeStart`, which lives only for the lifetime of the
`ModelSwitchModule` instance and is not written to any KV.

It depends on state owned elsewhere:

- The agent's model and provider, and whether the last change was a reset, come from
  `AgentBaseModelChange`, computed and persisted by `@slopus/happy-agent-base` itself.
  `ModelSwitchModule` only reads it.
- The optional `history` a host supplies is the same `HistoryModule` instance that owns and
  persists the archive itself (through its own injected `HistoryStore`); `ModelSwitchModule` holds
  a direct reference to it and only ever reads from it, through `history.messages` and
  `history.stats`, never writing to it.
