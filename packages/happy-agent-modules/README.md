# @slopus/happy-agent-modules

Everything an agent can *do*, as separately composable pieces.

[`@slopus/happy-agent-base`](https://www.npmjs.com/package/@slopus/happy-agent-base) owns only the
durable loop: context, queued messages, inference, tool dispatch, permission mode, storage, and
per-agent key-value scopes. It deliberately knows nothing about files, shells, goals, people, or
Git. This package is where all of that lives. A host picks the modules it wants, hands each one the
external services it cannot own itself, and gets an agent whose capabilities are exactly that list.

```ts
import { AgentSystemLocal } from "@slopus/happy-agent-base";
import {
    GoalModule,
    HistoryModule,
    ModelSwitchModule,
    SystemPromptModule,
    createComputeModules,
} from "@slopus/happy-agent-modules";

const history = new HistoryModule();
const compute = createComputeModules();

const system = await AgentSystemLocal.create(ctx, storage, {
    models,
    provider,
    providers,
    modules: [
        new SystemPromptModule(),
        history,
        new ModelSwitchModule({ history }),
        new GoalModule({}),
        ...compute.modules,
    ],
});

const agent = await system.create(ctx, {
    modules: { compute: { cwd: projectDirectory } },
});
```

`packages/happy-agent/sources/modules/agent/loadHappyAgent.ts` is the reference composition: it
builds all twenty-five modules, in order, over one SQLite database and one host compute.

## How a module works

A module is one shared instance serving an entire agent collection — never one instance per agent.
It contributes any of: model-facing **tools**, system-prompt **instructions**, lifecycle **hooks**,
ordered database **migrations**, and a **public API** the host can call directly without any agent
running at all. The tools and the public API are the same implementation; a tool is a thin
model-facing wrapper over the method a host would call.

- **State** lives in the agent database carried on `ctx.db`, in module-owned tables created by the
  module's own migrations, or in the Agent Base `kv` / `sharedKV` / `runKV` scopes. Never in
  instance fields.
- **Transactions** come from Agent Base. A mutating tool sets `transactional: true` so the base owns
  one transaction across execution, validation, rendering, and result settlement; a direct public
  mutation uses `ctx.inTx`. Modules hold no locks of their own.
- **Events** arrive twice: `onEventTransactional` inside the committing transaction, and `onEvent`
  after the host's outermost commit via stdlib `afterCommit`. A post-commit listener failure is
  reported, never converted into a failed tool call.
- **External things** — sockets, processes, credentials, clocks, schedulers, brokers, catalogs — are
  injected as narrow TypeBox-validated structural contracts. No module opens a database, spawns a
  process, or resolves a path on its own.
- **Isolation.** A module imports neither Rig nor another module. Where two capabilities must meet,
  the host injects the seam (`ModelSwitchModule` takes a `HistoryReader`; `UserInputModule` takes an
  optional presence check).

[GUIDELINES.md](./GUIDELINES.md) is the full normative rule set and the first thing to read before
writing or changing a module. [PLAN.md](./PLAN.md) records the migration this package exists to
serve. [NICE_TO_HAVE.md](./NICE_TO_HAVE.md) records Agent Base improvements that would make modules
smaller — none of them are blockers, and none may be worked around inside a module.

## Module catalog

Every module has its own README covering its exact tools, their permission and durability behavior,
its public methods, and its storage and event contracts.

### The conversation

| Module | What it adds |
|---|---|
| [System prompt](sources/systemPrompt/README.md) | Native per-vendor instructions chosen by the model in force, with a configurable identity. |
| [History](sources/history/README.md) | The agent's own durable record of what happened, separate from the compactable model context, readable back through `read_agent_history`. |
| [Model switch](sources/modelSwitch/README.md) | An honest notice when switching models resets a context that cannot be replayed, with a bounded excerpt of what was lost. |
| [AGENTS.md](sources/agentsMd/README.md) | Live project instructions discovered from the Git root down to the working directory. |
| [Skills](sources/skills/README.md) | User and project skills discovered live under `.agents/skills`, exposed as `list_skills` and `read_skill`. |

### The machine

| Module | What it adds |
|---|---|
| [Compute](sources/compute/README.md) | Ten provider-neutral filesystem and shell tools over one host machine, with read-before-write enforcement and background commands that outlive their wait. |
| [Permissions](sources/permissions/README.md) | The permission mode turned into behavior: per-call review, temporary elevation, refusal handling, and mode-change notices. |
| [MCP](sources/mcp/README.md) | MCP servers, tools, resources, and prompts through a host-owned protocol boundary, always reviewed in Auto. |
| [Search](sources/search/README.md) | A bounded common `web_fetch` plus explicit per-vendor search tool wrappers. |
| [Image generation](sources/imageGeneration/README.md) | Host-routed image generation returning opaque asset IDs and durable artifact evidence. |

### Work

| Module | What it adds |
|---|---|
| [Goal](sources/goal/README.md) | One durable long-running objective per agent, kept moving until complete, blocked, paused, or cleared. |
| [Tasks](sources/tasks/README.md) | A durable task list with dependencies, priority, ordering, and acyclicity validation. |
| [Scheduling](sources/scheduling/README.md) | Durable waits an agent can take, and messages it asks to be delivered to itself later. |
| [Workflows](sources/workflows/README.md) | Launch, inspect, wait for, resume, cancel, and read bounded logs from host-owned workflows. |
| [Worklets](sources/worklets/README.md) | Background compute installed from a folder, versioned and revertible, with a data folder that outlives every update. |
| [Usage](sources/usage/README.md) | Advisory token and timing accounting for one agent and its tree, which never fails a turn. |

### People and other agents

| Module | What it adds |
|---|---|
| [Collaboration](sources/collaboration/README.md) | Create collaborators, exchange durable messages, track reply obligations, and wait for answers. |
| [User input](sources/userInput/README.md) | Questions an agent asks a person, and a durable wait for the answer that survives a restart. |
| [Presence](sources/presence/README.md) | Configured versus effective availability, custom and temporary states, schedules, and status events. |
| [Happy](sources/happy/README.md) | The narrow bridge to a connected Happy client: notifications and agent status. |

### Places and things

| Module | What it adds |
|---|---|
| [Projects](sources/projects/README.md) | Repositories registered on demand, with bounded settings and durable rename and archival. |
| [Workspaces](sources/workspaces/README.md) | Isolated workspaces created, inspected, transferred, and archived through a host manager. |
| [Applets](sources/applets/README.md) | Import, version, inspect, revert, and remove host-managed applets and their assets. |
| [Slots](sources/slots/README.md) | Durable named values for Happy's fixed UI slots, with ordering and bounded paging. |
| [Secrets](sources/secrets/README.md) | Safe secret metadata, attachments, and a host-only resolver that never shows the model a value. |

### Storage ownership

Seventeen modules own tables through their own migrations: applets, collaboration, goal, happy,
history, mcp, presence, projects, scheduling, secrets, slots, tasks, usage, user input, workflows,
worklets, and workspaces. Eight own no storage at all: AGENTS.md, compute (Agent KV only),
image generation, model switch, permissions, search, skills, and system prompt.

Migrations are immutable once released. A schema change is a new keyed migration, never an edit to
an existing one.

## Host integrations

Modules that reach outside the database require the host to supply that reach. From
`HappyAgentIntegrations`:

| Module | Required from the host |
|---|---|
| Collaboration | `CollaborationBroker` |
| Happy | `HappyHost` |
| Image generation | `ImageGenerator`, output directory |
| MCP | `McpHost` |
| Scheduling | `SchedulingScheduler` |
| Search | `SearchBackend` |
| Slots | `SlotPublisher`, `SlotScopeResolver` |
| User input | `UserInputBroker` |
| Workflows | `WorkflowRuntime` |
| Worklets | `WorkletRuntime`, install root |
| Applets | Root directory |
| Compute | Compute provider (defaults to the published host provider) |
| Permissions | `PermissionReviewer` (optional; without it Auto cannot review) |
| Secrets | `SecretResolver` (optional; without it values cannot be resolved) |
| Workspaces | `WorkspaceHost` (optional; without it workspace operations report unavailable) |

## Design rules

- Runtime validation is TypeBox, with TypeScript types derived through `Static`. No parallel
  hand-written interfaces or predicates.
- A mutating tool is durable when its whole effect fits one database transaction, and explicitly
  non-durable when it crosses an external boundary that cannot commit atomically — a filesystem
  write, a process, a network delivery. Each module README says which of its tools are which and
  why.
- Every model-facing list, log, summary, and artifact has explicit item and character bounds, and
  says in its own result when it truncated something.
- Reads are bounded at the storage boundary, not at format time.
- Cross-agent access is denied by default until an injected authorization policy grants it.
- Provider-specific behavior lives in its own complete tool definition. Common tools are shared
  without capability detection or provider-key branching.
- `@slopus/happy-agent-base` is consumed exactly as published. Modules never change or extend it.

## Compatibility debt against legacy Rig

This package replaces the agent capabilities of the legacy Rig implementation still present in
`packages/rig/sources` and `packages/rig-execution/sources`. The intent is full feature and idea
parity, excluding storage mechanics, protocol projection, old-session migration, and the deliberate
non-goals in the repository `AGENTS.md`.

<!-- DEBT -->

## Development

```sh
pnpm --filter @slopus/happy-agent-modules check   # typecheck
pnpm --filter @slopus/happy-agent-modules test    # vitest
pnpm --filter @slopus/happy-agent-modules build   # tsc to dist/
```

Tests live in [`tests/`](./tests), mirroring the module folder names.
