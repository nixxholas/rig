# @slopus/happy-agent-modules

Everything an agent can _do_, as separately composable pieces.

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
const systemPromptCompute = {
    resolve: async (ctx, agentId) => await compute.computeModule.resolve(ctx, agentId),
};

const system = await AgentSystemLocal.create(ctx, storage, {
    models,
    provider,
    providers,
    modules: [
        new SystemPromptModule({ compute: systemPromptCompute }),
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

`ConfigModule.load()` resolves the `.happy` root and reads the layered
`Happy/Config/happy.toml` and `.happy/agent/runtime.toml` files. Load it before
constructing the remaining modules and place the same instance first in the
Agent System module array.

`packages/happy-agent/sources/modules/agent/loadHappyAgent.ts` is the reference composition: it
builds the standard modules, in order, over one SQLite database and one host compute.

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

| Module                                          | What it adds                                                                                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| [Config](sources/config/README.md)              | One frozen filesystem layout and layered Happy Agent settings snapshot shared by the host and all modules.                                |
| [System prompt](sources/systemPrompt/README.md) | Native per-vendor instructions, environment context, and live global/security/project AGENTS.md guidance.                                 |
| [History](sources/history/README.md)            | The agent's own durable record of what happened, separate from the compactable model context, readable back through `read_agent_history`. |
| [Model switch](sources/modelSwitch/README.md)   | An honest notice when switching models resets a context that cannot be replayed, with a bounded excerpt of what was lost.                 |
| [Skills](sources/skills/README.md)              | User and project skills discovered live under `.agents/skills`, exposed as `list_skills` and `read_skill`.                                |

### The machine

| Module                                                | What it adds                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Compute](sources/compute/README.md)                  | Ten provider-neutral filesystem and shell tools over one host machine, with read-before-write enforcement and background commands that outlive their wait. |
| [Permissions](sources/permissions/README.md)          | The permission mode turned into behavior: per-call review, temporary elevation, refusal handling, and mode-change notices.                                 |
| [MCP](sources/mcp/README.md)                          | MCP servers, tools, resources, and prompts through a host-owned protocol boundary, always reviewed in Auto.                                                |
| [Search](sources/search/README.md)                    | A bounded common `web_fetch` plus explicit per-vendor search tool wrappers.                                                                                |
| [Image generation](sources/imageGeneration/README.md) | Host-routed image generation returning opaque asset IDs and durable artifact evidence.                                                                     |

### Work

| Module                                     | What it adds                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| [Goal](sources/goal/README.md)             | One durable long-running objective per agent, kept moving until complete, blocked, paused, or cleared.               |
| [Tasks](sources/tasks/README.md)           | A durable task list with dependencies, priority, ordering, and acyclicity validation.                                |
| [Scheduling](sources/scheduling/README.md) | Durable waits an agent can take, and messages it asks to be delivered to itself later.                               |
| [Workflows](sources/workflows/README.md)   | Launch, inspect, wait for, resume, cancel, and read bounded logs from host-owned workflows.                          |
| [Worklets](sources/worklets/README.md)     | Background compute installed from a folder, versioned and revertible, with a data folder that outlives every update. |
| [Usage](sources/usage/README.md)           | Advisory token and timing accounting for one agent and its tree, which never fails a turn.                           |

### People and other agents

| Module                                           | What it adds                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| [Collaboration](sources/collaboration/README.md) | Create collaborators, exchange durable messages, track reply obligations, and wait for answers.      |
| [User input](sources/userInput/README.md)        | Questions an agent asks a person, and a durable wait for the answer that survives a restart.         |
| [Presence](sources/presence/README.md)           | Configured versus effective availability, custom and temporary states, schedules, and status events. |
| [Happy](sources/happy/README.md)                 | The narrow bridge to a connected Happy client: notifications and agent status.                       |

### Places and things

| Module                                     | What it adds                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [Projects](sources/projects/README.md)     | Repositories registered on demand, with bounded settings and durable rename and archival.       |
| [Workspaces](sources/workspaces/README.md) | Isolated workspaces created, inspected, transferred, and archived through a host manager.       |
| [Applets](sources/applets/README.md)       | Import, version, inspect, revert, and remove host-managed applets and their assets.             |
| [Slots](sources/slots/README.md)           | Durable named values for Happy's fixed UI slots, with ordering and bounded paging.              |
| [Secrets](sources/secrets/README.md)       | Safe secret metadata, attachments, and a host-only resolver that never shows the model a value. |

### Storage ownership

Seventeen modules own tables through their own migrations: applets, collaboration, goal, happy,
history, mcp, presence, projects, scheduling, secrets, slots, tasks, usage, user input, workflows,
worklets, and workspaces. Seven own no tables: compute, image generation, model switch,
permissions, search, skills, and system prompt. Compute and system prompt use Agent KV only.

Migrations are immutable once released. A schema change is a new keyed migration, never an edit to
an existing one.

## Host integrations

Modules that reach outside the database require the host to supply that reach. From
`HappyAgentIntegrations`:

| Module           | Required from the host                                                         |
| ---------------- | ------------------------------------------------------------------------------ |
| Collaboration    | `CollaborationBroker`                                                          |
| Happy            | `HappyHost`                                                                    |
| Image generation | `ImageGenerator`, output directory                                             |
| MCP              | `McpHost`                                                                      |
| Scheduling       | `SchedulingScheduler`                                                          |
| Search           | `SearchBackend`                                                                |
| Slots            | `SlotPublisher`, `SlotScopeResolver`                                           |
| User input       | `UserInputBroker`                                                              |
| Workflows        | `WorkflowRuntime`                                                              |
| Worklets         | `WorkletRuntime`, install root                                                 |
| Applets          | Root directory                                                                 |
| Compute          | Compute provider (defaults to the published host provider)                     |
| Permissions      | `PermissionReviewer` (optional; without it Auto cannot review)                 |
| Secrets          | `SecretResolver` (optional; without it values cannot be resolved)              |
| Workspaces       | `WorkspaceHost` (optional; without it workspace operations report unavailable) |

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

Every module was audited against its legacy counterpart. What follows is what is still missing or
deliberately different. Anything not listed here has parity.

### Conversation

**System prompt** — none. The environment section, the available-model list, and global,
`AGENTS_SECURITY.md`, and project `AGENTS.md` instructions are all delivered, with the AGENTS.md
spec spliced in and the whole block truncated to the remaining UTF-8 prompt budget. Global
instructions arrive through an injected reader rather than a hardcoded `~/.happy/AGENTS.md` path.

**History** — none. Bounded agent-tree listings, ID and path targets, and one-line tool-result
display summaries are all present. Agent listing, target resolution, and tool display arrive through
injected host seams rather than being computed inside the module.

**Model switch** — the notice fires on a session's first model selection rather than only on a
later switch; subagent count is dropped from the history overview; only the excerpt substring is
bounded, not the injected message as a whole.

**Skills** — the `/skill:<name>` user command is not reproduced; it belongs to the app layer, not
this module. Builtin, plugin, and durable skill roots are back through an injected root list, with
plugin symlink protection and collision precedence, frontmatter is parsed as YAML, the directory
walk skips dotfiles and `node_modules`, and the safety and UX guidance is restored to the
system-prompt text.

### Machine

**Compute** — two gaps. `run_command` has no `secrets` argument: the host compute's secret option
has no resolver or injection seam here, and wiring one is a host and provider integration rather
than something this module can do by treating secret identifiers as ordinary environment variables.
And there is no per-path locking during concurrent edits — legacy write tools declared a lock key
per path, which Agent Base's tool contract cannot express. Everything else has parity: delete, move,
and multi-file patch exist, `search_files` honors `.gitignore`, `run_command` takes a shell
selection, protected project-config paths are enforced, and images are viewable.

**Permissions** — none. Sandbox-limit prose and per-tool guidance are back in the Auto instructions
through an injected guidance provider, risk mechanically overrides an "allow" verdict, reducing the
mode kills running elevated sessions through an injected killer, the circuit breaker has a
long-window rate limit and stops the turn when it trips, a missing `describeAutoPermissionAction` is
refused rather than papered over, and a timed-out review is cancelled. A concrete
`PermissionReviewer` still lives outside this package: without one, Auto cannot review.

**MCP** — no per-server call serialization, for the same reason as compute: Agent Base has no
tool-level lock declaration. Tool-name collisions now quarantine the offending server and surface it
through `list_mcp_servers` instead of aborting the whole list, and `enabledTools`/`disabledTools` are
enforced before dispatch.

**Search** — vendor-specific search tools, LLM-backed `web_fetch` extraction, provider and account
selection, Auto-mode review, redirect and domain safety handling, binary persistence, and the result
presentation layer are all absent. This module is deliberately a thin generic boundary for now.

**Image generation** — no image-edit or reference-image input; generated bytes are never returned to
the model, only asset IDs; no structural PNG validation; multi-account rotation moved out of the
module into the host.

### Work

**Goal** — none. Resuming a completed goal is blocked, a failed or aborted turn and archival pause
the goal automatically, and interruption, session titling, and primary-agent restriction arrive
through an injected `GoalHost`. Without that host wired, those three behaviors degrade silently
rather than failing.

**Tasks** — none. `remove_task` exists alongside legacy `status: "deleted"`, `owner`, `activeForm`,
and a bounded JSON `metadata` bag are back, dependencies are bidirectional with incremental add and
remove, unresolved-dependency filtering is restored, and model-facing mutations return typed
failures instead of throwing.

**Scheduling** — none. Cross-agent `agent_id` targeting, configurable long horizons, ISO, RFC, and
Unix date forms, compound and free-text durations, and past-date clamping are all present. The
"never available to subagents" rule is enforced by an injected `scheduleMessagePolicy` that denies by
default: with no policy wired, `schedule_message` is not exposed at all.

**Workflows** — legacy's exact `steerable` and `interruptionMessage` UI behavior is not reproduced;
it depends on presentation the frozen Agent Base does not expose. Bounded `script`/`scriptPath`,
JSON `args`, `name`, `description`, and `resumeFromRunId` are present, status and wait observations
carry `agentCount` and bounded accumulated `logs` with a `logsTruncated` flag, a wait can be
cancelled without stopping the workflow through an optional runtime signal, the overuse warning is
back, and the legacy status vocabulary is projected alongside the new one.

**Worklets** — the largest single gap in the package. Worklet-declared tools are not first-class
agent tools, there is no `worklet.json` manifest identity or permission model, no disk or network
enforcement, no required README/DEVELOPMENT/icon, no workspace boundary on the source path, no
review requirement on install, update, revert, or uninstall, and `worklet_list` lost its inline
status. No runtime is implemented anywhere in the new stack yet.

**Usage** — after a compaction, current context is omitted rather than estimated, because Agent Base
exposes no approximate post-compaction figure; it reappears exact on the next measurement.
`get_agent_tree_usage` exists with default-deny authorization, current-context fullness is reported,
and `get_usage` can report the whole collection to a host-neutral caller.

### People and other agents

**Collaboration** — one deliberate difference: legacy's "inspect before message" gate is not
reproduced, and `list_agents` allows enumeration within the collection. Cross-agent access is denied
by default until an injected authorization policy grants it, which is judged the better control.
Interruption, model and effort selection, read-only collaborators, completion and output observation,
context forking, and spawn capacity and depth signals are all present.

**User input** — no Inbox reordering. `master-plans/06-inbox.md` calls for reordering pending
requests by fractional index, and neither the request record nor the store has an order field.
Everything else has parity: `cancel_ask` exists, questions batch, there is a non-blocking
auto-resolution window and a 12-character `header`, away and timeout messaging carries guidance and
an expected-return estimate, and the wait honors a per-presence-state duration and re-arms when
presence changes mid-wait.

**Presence** — date-specific schedules are unsupported. Per-state `answerWaitMs`, a persisted custom
state catalog with `list_presences`, per-state title, emoji, prompt, and model instructions, and
`set_presence`'s `until` and `fallbackPresenceId` are all present. The per-state wait duration is
published as a policy seam that user input consumes.

**Happy** — model-set status can drift from real activity, where legacy status could not; there is
no system-observable status fallback, so `get_happy_status` returns nothing until the model sets it;
the pending-question channel has no equivalent.

### Places and things

**Projects** — none. `unarchive_project` exists and `ensure_project` restores archived rows, durable
`orderKey` ordering and `reorder_project` are back, avatars have set and clear operations with an
optional injected asset reader, and rename and settings updates are guarded by a project `version`
and `expectedVersion`.

**Workspaces** — none. Creation and archive host hooks exist with transitional `initializing` and
`archiving` states, rename is implemented end to end, records carry a bounded optional `path`,
archive and transfer are reviewed in Auto with destructive descriptions and no full-access
elevation, and `list_workspaces` includes archived rows by default again. Reconciling a transitional
state to a terminal one is the host's responsibility.

**Applets** — one deliberate difference: an applet keeps at most 100 versions, where legacy kept
them unbounded. Icon guarantees, path confinement, session-filesystem imports through an injected
reader, full catalog metadata, scope enforcement, launch-context tokens, per-applet mutation
serialization, and Auto-permission posture are all restored.

**Slots** — plugin-authored entries and their cleanup are gone, and mutation ownership is stricter
than legacy's open model with no override. Combined scope-context list filtering was lost, and
`remove_slot` no longer returns the removed entry.

**Secrets** — no path from an attached secret into a running command, which is legacy's whole point.
The catalog, attachment, and host-only resolution all work, but compute's `run_command` has no
`secrets` argument to consume them (see Compute above), so an attached secret currently reaches
nothing. Closing this needs a host and provider integration, not a module change.

Two further differences are deliberate. `request_secret` is not a secrets-catalog operation: asking
a person to enter a value belongs to user input, and this module only stores or resolves a value the
host already supplied. GitHub CLI token synchronization and the managed `project-git` credential
lease are host infrastructure, not flat environment bundles, and stay outside this package.

Managed versus model-attachable secrets, environment-name collisions, ambient-variable hiding, and
reserved IDs (`github`, `project-git`) are all handled.

### Blocked on Agent Base

Legacy serialized concurrent work by letting a tool declare a lock key, and `@slopus/happy-agent-base`
is consumed exactly as published. Its tool contract (`AgentTool`) has no lock member, and its only
locks are `AgentSystemLocal`'s private per-agent map, which a tool cannot influence. The module
contract separately forbids module-level in-memory locks. Compute's per-path locking and MCP's
per-server call serialization are therefore both unreachable from this package without a change to
the base. A module must not fake this by attaching an inert `locks` property to a tool object.

### Excluded by design

Storage mechanics, protocol projection and SSE, the TUI, old-session migration, and the non-goals
recorded in the repository `AGENTS.md` are out of scope and are not counted as debt.

## Development

```sh
pnpm --filter @slopus/happy-agent-modules check   # typecheck
pnpm --filter @slopus/happy-agent-modules test    # vitest
pnpm --filter @slopus/happy-agent-modules build   # tsc to dist/
```

Tests live in [`tests/`](./tests), mirroring the module folder names.
