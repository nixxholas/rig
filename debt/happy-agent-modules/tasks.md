# Module report: tasks

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/tasks/` (README, `TasksModule.ts`,
`Task.ts`, `impl/taskDatabase.ts`, `impl/taskKV.ts`, `tools/`) compared against Rig's only equivalent,
the Codex vendor tool `packages/rig/sources/agent/tools/codex/update_plan.ts` (and Grok's
`todo_write` in `packages/happy-providers/sources/vendors/grok/tools/todo_write.ts`), root `AGENTS.md`,
and master plans 00, 07, 16, 20, 21.

## Summary

A persistent task tracker with five tools (`create_task`, `list_tasks`, `get_task`, `update_task`,
`complete_task`), a dependency graph with cycle detection, priorities, and contiguous ordering, all stored
per agent in SQLite. Rig has no such feature: the only planning surface in the codebase is Codex's
ephemeral `update_plan`, which stores nothing and validates one rule. This module invents a product feature
— a durable, queryable, dependency-aware todo backend — with no vendor trace and no master plan behind it.

## How it differs from Rig's equivalents

- **Ephemeral vs. durable.** `agent/tools/codex/update_plan.ts` takes the whole plan on every call, keeps no
  storage, and its execute body does one thing: check that at most one step is `in_progress`. It is a
  vendor tool because Codex was trained on it. Every tool here is `durable: true` and writes to
  `happy_agent_task_state`.
- **One tool vs. a CRUD surface.** Codex has a single `update_plan`; Grok has a single `todo_write`. Both
  are whole-list replacements, which is what models are trained to emit. This module splits the same idea
  into five tools plus `dependsOn` graphs, `priority`, and `ordering` — a schema the models have no prior on
  and will use inconsistently.
- **Naming.** Neither vendor name is used. `create_task`/`update_task`/`complete_task` is a third
  vocabulary alongside `update_plan` and `todo_write`.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities in
   `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules` at all.
2. **The feature itself is invented.** No vendor descriptor, golden trace, or master plan asks for a
   persistent task store with dependencies. AGENTS.md reserves common tools for Rig product capabilities;
   a dependency-graph todo list is neither a vendor surface nor a documented product capability. The cycle
   detection, contiguity invariants, and priority model are engineering built for a requirement that has not
   been stated.
3. **State is in the wrong place.** Plan 21 requires feature state to live in the `AgentKV` stores passed to
   the feature. This module opens its own table via migration `001-task-state`
   (`happy_agent_task_state(agent_id TEXT PRIMARY KEY, tasks_json TEXT NOT NULL)`). `impl/taskKV.ts` is a
   six-line file named "KV" that just constructs `new TaskDatabase(agentId)` — the name asserts compliance
   the code does not have.
4. **The whole list is one JSON blob.** `impl/taskDatabase.ts` stores all of an agent's tasks in a single
   `tasks_json` column; every create, update, and complete reads the entire array, mutates it, and rewrites
   it. With `MAX_TASKS=500` that is survivable, but it means no per-task concurrency and no way to query
   without deserializing everything — an odd choice for a module whose selling point over `update_plan` is
   durability.
5. **The README's first example throws.** `TasksModule`'s constructor takes a required
   `TasksModuleOptions` and calls `assertTasksModuleOptions` (`TasksModule.ts:924-930`), which rejects
   `undefined`; the README's opening snippet is `const tasks = new TasksModule();` (README:13). The
   documented entry point does not run.
6. **Inconsistent schema policy.** `opaqueContextSchema = Type.Any()` (`TasksModule.ts:75-76`) is used for
   context and results, while the slots and usage modules use `Type.Unsafe<Context>` with exacting object
   shapes. Three modules in one package take three positions on how to type the same trusted `Context`, and
   `Type.Any()` here means the validation is decorative.
7. **Public methods that are not tools.** `remove`, `reorder`, and `reset` exist on the module but are not
   exposed as tools, so an agent can create tasks and complete them but never delete or reorder them. Either
   the surface is incomplete or the methods are speculative API; nothing in the README resolves which.
8. **No review on any mutation.** All five tools declare `shouldReviewInAutoMode: () => false`
   (`create_task.ts:32-34`, `list_tasks.ts:14-15`, `get_task.ts:28-29`, `update_task.ts:34-37`,
   `complete_task.ts:16-18`). That is defensible for agent-private bookkeeping — and correctly none of them
   asks for Full access, so review is not coupled to elevation — but it is worth noting that these tools
   write durable state with no user checkpoint anywhere.

## What it gets right

The invariants are actually enforced rather than described: dependency cycles are rejected at write time,
`dependsOn` entries must reference existing tasks and are bounded and de-duplicated, ordering stays
contiguous after every mutation, and the task count is capped at `MAX_TASKS=500` with a `DEFAULT_MAX_TASKS`
of 100 — so unlike several sibling modules, state here is genuinely bounded. Every tool is `durable: true`
and mutations run inside the module's transaction, so a crash mid-turn cannot leave a half-applied task
list. Tool descriptions are plain and the README documents the invariants it implements.
