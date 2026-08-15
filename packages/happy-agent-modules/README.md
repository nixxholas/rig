# @slopus/happy-agent-modules

Ready-made capabilities for agents built on
[`@slopus/happy-agent-base`](../happy-agent-base).

Agent Base owns the minimal durable inference and tool loop. This package supplies the product
modules a host composes into that loop: tools, instructions, lifecycle hooks, persistence
contracts, public host APIs, and transactional/post-commit events.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { HistoryModule, SystemPromptModule } from "@slopus/happy-agent-modules";

const history = new HistoryModule({ store: historyStore });
const systemPrompt = new SystemPromptModule();

const agent = await Agent.create(ctx, {
    ...options,
    modules: [history, systemPrompt],
});
```

One module instance normally serves every agent in a collection. Agent-specific state is keyed
by the calling agent and lives in the supplied host store or Agent KV, not in mutable
module-instance maps. A host can also call a module's public methods directly without creating
an agent.

## Module catalog

- [AGENTS.md](sources/agentsMd/README.md) — live project instructions discovered through the
  agent's compute.
- [Applets](sources/applets/README.md) — import, version, inspect, and remove host-managed applets.
- [Collaboration](sources/collaboration/README.md) — create collaborators, exchange durable
  messages, and wait for replies.
- [Compute](sources/compute/README.md) — provider-neutral filesystem and shell tools over a
  host-supplied machine.
- [Goal](sources/goal/README.md) — durable long-running objectives, continuation, failure
  blocking, and external wake scheduling.
- [History](sources/history/README.md) — transactional conversation archival and bounded history
  reading.
- [Image generation](sources/imageGeneration/README.md) — host-routed image generation with
  durable request and artifact evidence.
- [Model switch](sources/modelSwitch/README.md) — truthful handoff when incompatible model
  histories cannot be replayed.
- [Permissions](sources/permissions/README.md) — one permission model for review, temporary
  elevation, refusal, and mode changes.
- [Presence](sources/presence/README.md) — durable agent presence, availability, and status
  events.
- [Projects](sources/projects/README.md) — repositories registered on demand, with bounded
  settings and durable rename and archival.
- [Scheduling](sources/scheduling/README.md) — durable waits an agent can take, and messages it
  asks to be delivered to itself later.
- [Search](sources/search/README.md) — bounded common web fetch plus explicit vendor search
  wrappers.
- [Secrets](sources/secrets/README.md) — safe secret metadata, attachments, and a host-only
  resolver.
- [Skills](sources/skills/README.md) — live user and project skills discovered through the
  agent's compute.
- [Slots](sources/slots/README.md) — durable named values with ordering and bounded paging.
- [System prompt](sources/systemPrompt/README.md) — model-aware native prompt selection and
  identity substitution.
- [Tasks](sources/tasks/README.md) — durable task creation, dependency tracking, updates, and
  completion.
- [Usage](sources/usage/README.md) — bounded provider and agent-tree usage observation.
- [User input](sources/userInput/README.md) — questions an agent asks a person, and the durable
  wait for an answer that survives a restart.
- [Workflows](sources/workflows/README.md) — launch, inspect, cancel, resume, wait for, and read
  logs from host-owned workflows.
- [Worklets](sources/worklets/README.md) — background compute installed from a folder, versioned
  and revertible, with a data folder that outlives every update.
- [Workspaces](sources/workspaces/README.md) — create, inspect, transfer, and archive isolated
  workspaces through a host manager.

Each module document describes:

- the exact tools exposed to the model and their permission/durability behavior;
- the public methods available to hosts;
- the storage, paging, output, and event contracts involved.

## Design rules

- Runtime validation uses TypeBox schemas, with TypeScript types derived through `Static`.
- Mutating tools are transactional when their whole effect fits one database transaction and
  non-durable when they cross an external boundary that cannot be committed atomically.
- Host stores remain authoritative. Module code validates every host response before returning
  a clone or formatting it for the model.
- Transactional listeners run with the mutation. Post-commit listeners run only after durable
  commit, and their failures cannot turn a committed operation into a failed tool call.
- Model-facing lists, logs, summaries, and artifacts have explicit item and character bounds.
- Provider-specific behavior stays in its own complete tool definition; common tools are shared
  without capability detection or provider-key branching.
- `@slopus/happy-agent-base` is consumed as-is. Modules do not change or extend its core.
