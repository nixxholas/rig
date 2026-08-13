# @slopus/happy-agent-features

Ready-made features for agents built on [`@slopus/happy-agent-base`](../happy-agent-base).

A feature is one independent capability: tools, instructions, and hooks that the agent merges
into the loop. Each feature here is self-contained, holds its state in the store the agent lends
it, and knows nothing about the others.

`@slopus/happy-agent-base` provides only the durable runtime and extension primitives. Concrete
capabilities and their documentation live here.

## Goal

Long-running work. The model starts a goal with `create_goal`, reads it with `get_goal`, and ends
it with `update_goal` by declaring it complete or blocked. When the agent would settle back to
idle with a goal still active, the feature sends it a message asking it to carry on, so the loop
starts another turn instead of stopping.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { GoalFeature } from "@slopus/happy-agent-features";

const agent = await Agent.create(ctx, { ...options, features: [new GoalFeature()] });
```

One instance serves every agent in a collection. Each agent's goal lives in that agent's own
feature store, so it follows the conversation and survives a restart. Pausing, resuming, and
clearing a goal belong to the person who set it: `readGoal`, `writeGoal`, and `clearGoal` are
exported for the host that offers those controls.

## System prompt

The instructions a model is written for. Every model is told how to behave in its own words, so
the prompt follows the model rather than the agent: the feature reads the selection from the scope
it is handed and returns that model's prompt, and an agent that switches models mid-conversation
is given the new one on the very next inference.

```ts
const agent = await Agent.create(ctx, { ...options, features: [new SystemPromptFeature()] });
```

A model with a prompt of its own gets that one; anything else falls back to the family its ID
names, and only then to the kind of provider serving it — a Claude model served through Bedrock is
still a Claude model. A model belonging to no known family gets the simple prompt, so there is
always a prompt. Pass `identity` to name the agent something other than Rig; it replaces the
`{{identity}}` and `{{name}}` markers the prompts carry.

## History

The agent's own record of what happened, which it can read back. It is not the model's context:
the context is what the provider is replaying right now and is compacted, reset, and thrown away
as the conversation moves, while the history is what was said and done, kept whether or not any
model can still see it.

```ts
const history = new HistoryFeature({ store });
const agent = await Agent.create(ctx, { ...options, features: [history] });
await history.record(ctx, agent.id, { role: "user", blocks: [{ type: "text", text }] });
```

The feature records each completed response, each tool result, and each failed inference as the
agent works, and never lets that recording decide anything — a store that is slow or broken loses
the record, not the run. User messages belong to whoever sent them, so the host records those with
`record`. Reading is the `read_agent_history` tool for the model and `read` for everyone else,
over the same paging, searching, and size bounding.

The store is the host's: implement `HistoryStore` over a database, an archive, or an existing
transcript, and the feature keeps nothing of its own.

## Model switch

Switching between incompatible models erases the conversation: their transcripts cannot be
replayed to one another, so the new model starts with an empty context while the work the old one
did still stands. This feature puts one system message at the head of that fresh context saying
what changed and that a conversation it cannot see came before, so the model orients itself
instead of answering as though nothing happened.

```ts
const agent = await Agent.create(ctx, {
    ...options,
    features: [new ModelSwitchFeature({ historyTool: "read_agent_history" })],
});
```

Name `historyTool` when the agent has a tool that reads its durable history, and the notice tells
the new model to go and read what it can no longer see. Pass `history` — a `HistoryFeature` — and
the notice also carries an overview and both ends of the erased conversation, bounded, so the new
model starts by reading what happened rather than only being told that something did. A compatible
switch keeps the history and produces no notice.
