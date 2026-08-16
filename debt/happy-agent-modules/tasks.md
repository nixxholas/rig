# Module report: tasks

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/tasks/` (README, `TasksModule.ts`,
`Task.ts`, `impl/taskDatabase.ts`, `impl/taskKV.ts`, `tools/`) reviewed as the v2 successor to v1's only
planning surface, the Codex vendor tool `packages/rig/sources/agent/tools/codex/update_plan.ts` (with
Grok's `todo_write` in `packages/happy-providers/sources/vendors/grok/tools/todo_write.ts` as the other
vendor reference), against root `AGENTS.md` and master plans 00, 07, 16, 20, 21.

## Summary

A persistent task tracker with five tools (`create_task`, `list_tasks`, `get_task`, `update_task`,
`complete_task`), a dependency graph with cycle detection, priorities, and contiguous ordering, stored per
agent in SQLite. As a rewrite it is a deliberate upgrade over v1's ephemeral plan list, and its invariants
are genuinely enforced. The open questions are where the state lives (plan 21 says `AgentKV`, this uses its
own table behind a file named `taskKV.ts`), a surface that can create tasks but never delete or reorder
them, and a README whose first example does not run.

## Changes from the Rig v1 implementation

- **Durable instead of ephemeral (deliberate improvement).** v1's `update_plan` takes the whole plan on every
  call, stores nothing, and its execute body checks one rule: at most one step `in_progress`. v2 persists
  tasks in `happy_agent_task_state`, so a plan survives compaction, restart, and handoff. That is a real
  capability v1 did not have.
- **A CRUD surface instead of whole-list replacement (design change with a cost).** Codex has a single
  `update_plan` and Grok a single `todo_write`; both are whole-list writes, which is the shape the models
  were trained to emit. v2 splits the idea into five tools plus `dependsOn`, `priority`, and `ordering`.
  Incremental mutation is the right primitive for durable storage, but the models have no prior on this
  schema, so expect inconsistent use until the tool descriptions or examples compensate.
- **New vocabulary (churn).** `create_task`/`update_task`/`complete_task` is a third naming set alongside
  `update_plan` and `todo_write`. Neither vendor name survives, so nothing a model already knows transfers.
- **Dependencies, priorities, and ordering are new (improvement, unspecified).** None of this existed in v1.
  It is well implemented (see "What it gets right"), but no master plan describes the intended product
  behavior, so there is nothing to check the design against — worth pinning down before it hardens.

## Findings

1. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still place ready-made agent
   capabilities in `@slopus/happy-agent-features` and do not mention `happy-agent-modules`. For this module
   the gap matters more than usual, because a durable dependency-aware task store is a new product feature
   with no plan describing what it should do.
2. **State is not in `AgentKV`.** Plan 21 requires feature state to live in the `AgentKV` stores passed to
   the feature. This module opens its own table via migration `001-task-state`
   (`happy_agent_task_state(agent_id TEXT PRIMARY KEY, tasks_json TEXT NOT NULL)`), and `impl/taskKV.ts` is a
   six-line file named "KV" that merely constructs `new TaskDatabase(agentId)` — the filename asserts a
   compliance the code does not have. Either move the state or get the plan updated; the current name hides
   the divergence.
3. **The whole list is one JSON blob.** `impl/taskDatabase.ts` stores all of an agent's tasks in a single
   `tasks_json` column; every create, update, and complete reads the entire array, mutates it, and rewrites
   it. With `MAX_TASKS=500` that is survivable, but it gives no per-task concurrency and no way to query
   without deserializing everything — an odd shape for the module whose whole advantage over v1 is durable
   storage.
4. **The README's first example throws.** `TasksModule`'s constructor takes a required `TasksModuleOptions`
   and calls `assertTasksModuleOptions` (`TasksModule.ts:924-930`), which rejects `undefined`; the README's
   opening snippet is `const tasks = new TasksModule();` (README:13). The documented entry point does not
   run.
5. **Inconsistent schema policy across the package.** `opaqueContextSchema = Type.Any()`
   (`TasksModule.ts:75-76`) types context and results, while the slots and usage modules use
   `Type.Unsafe<Context>` with exacting object shapes. Three modules in one package take three positions on
   how to type the same trusted `Context`, and `Type.Any()` makes the validation here decorative.
6. **The tool surface is incomplete.** `remove`, `reorder`, and `reset` exist as public methods but are not
   exposed as tools, so an agent can create and complete tasks but never delete or reorder them — and with
   `MAX_TASKS=500` a long session eventually wedges. Either the tools are missing or the methods are
   speculative; nothing in the README resolves which.
7. **No review on any mutation.** All five tools declare `shouldReviewInAutoMode: () => false`
   (`create_task.ts:32-34`, `list_tasks.ts:14-15`, `get_task.ts:28-29`, `update_task.ts:34-37`,
   `complete_task.ts:16-18`). Defensible for agent-private bookkeeping, and correctly none of them asks for
   Full access, so review is not coupled to elevation — but these are the first tools in the product that
   write durable state with no user checkpoint at any point.

## What it gets right

The invariants are enforced rather than merely described: dependency cycles are rejected at write time,
`dependsOn` entries must reference existing tasks and are bounded and de-duplicated, ordering stays
contiguous after every mutation, and the task count is capped at `MAX_TASKS=500` with a `DEFAULT_MAX_TASKS`
of 100 — so unlike several sibling modules, state here is genuinely bounded. Every tool is `durable: true`
and mutations run inside the module's transaction, so a crash mid-turn cannot leave a half-applied task
list. Tool descriptions are plain English and the README documents the invariants the code actually
implements.
