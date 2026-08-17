# Module report: workflows

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/workflows/` as the v2 rewrite of
Rig's v1 workflow surface (`packages/rig/sources/tools/workflows/`,
`packages/rig/sources/workflows/`), against root `AGENTS.md` and master plans 00, 16, 20, 21.

> **Update, 2026-08-17.** The module was rewritten to execute workflows itself, as v1 did: the
> `WorkflowRuntime` injection is gone, `@pydantic/monty` is back, and agents are started through
> the collaboration module. This addresses findings 1, 2, 4, 6, 7 and the "generalized past its
> implementation", "review and elevation lost" and "invented lifecycle states" entries below —
> `paused` now has a producer, `workflow_logs` has a write path, and `run_workflow` reviews and
> elevates a `scriptPath` again. `toUI` is still missing, and the v1 tool-name collisions remain
> until the v1 surface is removed. The review below is kept as the record of what was wrong.

## Summary

`WorkflowsModule` is ~2,000 lines implementing seven tools — `run_workflow`, `list_workflows`,
`workflow_status`, `cancel_workflow`, `resume_workflow`, `wait_workflow`, `workflow_logs` — around
an injected `WorkflowRuntime`. The rewrite generalizes v1's concrete capability (a sandboxed Python
multi-agent orchestrator) into a host-owned run catalog, which is a defensible direction, but the
runtime that would give it meaning does not exist yet, `workflow_logs` is wired to a table nothing
writes, and v1's review-and-elevate behavior on the tool that starts host compute was not carried
over. Two tool names collide with still-live v1 tools under different schemas. Most of the module's
mass is defensive re-validation of a store the module itself constructs.

The master plans still name `@slopus/happy-agent-features` and have not been updated for the
`happy-agent-modules` rewrite.

## Changes from the Rig v1 implementation

- **Improvement — durable run catalog and lifecycle invariants.** v1 held runs in memory behind
  `context.workflows` and exposed status by reading them (`workflow_status.ts:30-45`). v2 owns
  durable rows with status-specific schemas, timestamp-ordering invariants
  (`WorkflowStore.ts:134-158`), and transition checks that require a cancel of a terminal run to be
  an exact no-op and forbid field changes outside the transition
  (`WorkflowsModule.ts:857-915`).
- **Improvement — bidirectional paging and a wait tool.** v1's `workflow_status` returned the whole
  log array inline; v2 pages runs and logs from either end with prev/next cursors, and adds
  `wait_workflow` for a broker-backed terminal wait (`tools/wait_workflow.ts`).
- **Open debt — the capability is generalized past its implementation.** v1's `workflow` tool
  describes exactly what it runs, in 33 lines of model guidance
  (`createWorkflowTool.ts:13-45`). v2's `run_workflow` starts "a host-managed workflow" named by an
  opaque string with an opaque string input (`tools/run_workflow.ts:13-15`), and no
  `WorkflowRuntime` implementation exists in the repository. Until one does, the rewrite has
  replaced a working feature's surface with an abstract one.
- **Regression — review and elevation lost on the tool that starts compute.** v1 reviews and
  elevates when it must read a script off disk, and explains itself:
  `shouldReviewInAutoMode`, `shouldRunInFullAccessInAutoMode`, and `describeAutoPermissionAction`
  all keyed on `scriptPath` (`createWorkflowTool.ts:85-96`). All seven v2 tools declare
  `shouldReviewInAutoMode: () => false` and define none of the other three
  (`tools/run_workflow.ts:18`, `tools/cancel_workflow.ts:18`, `tools/resume_workflow.ts:18`,
  `tools/wait_workflow.ts:18`, `tools/list_workflows.ts:19`, `tools/workflow_status.ts:18`,
  `tools/workflow_logs.ts:18`).
- **Regression — no UI rendering.** Every v1 workflow tool defines `toUI`
  (`createWorkflowTool.ts:169`, `stop_workflow.ts:28`, `workflow_status.ts:47`). No v2 tool does.
- **Open debt — invented lifecycle states with no producer.** v2 adds `queued`, `paused`, and
  `unavailable` to v1's `running`/`completed`/`error`/`stopped`, and `resume_workflow` accepts only
  a paused run (`WorkflowsModule.ts:892-900`). Nothing can currently produce a paused run, so the
  tool covers a state that does not yet exist.

## Findings

1. **Starting host compute is never reviewed.** `run_workflow` hands an arbitrary workflow name and
   input to a runtime whose execution boundary is, by the tool's own description, outside Rig —
   "The host owns runtime, processes, filesystem, and permissions" (`tools/run_workflow.ts:14`) —
   and declares `shouldReviewInAutoMode: () => false`. AGENTS.md reserves `requiresAutoOrFullAccess`
   for exactly this case: "tools such as MCP operations whose external execution boundary cannot be
   enforced by Rig's local sandbox." Sibling modules in the same package already do this
   (`sources/mcp/createMcpTool.ts:40`, `sources/applets/tools/create_applet.ts:20-23`); workflows
   does not. `cancel_workflow` and `resume_workflow` mutate that same external state unreviewed.
2. **`workflow_logs` can never return a line.** `WORKFLOW_LOGS_TABLE` is created
   (`WorkflowsModule.ts:173-180`) and read (`WorkflowDatabase.ts:254-276`), and there is no `INSERT`
   into it anywhere in the package. The tool, its schema, its cursor arithmetic
   (`assertExactLogPage`, `WorkflowsModule.ts:1003-1020`), its per-line budget formatter
   (`formatLogsForModel`, lines 442-468), and its README entry all describe a feature that returns
   an empty page for every input.
3. **Name collisions with still-live v1 tools.** `workflow_status` exists in both with different
   arguments: v1 takes `run_id` and returns logs inline
   (`packages/rig/sources/tools/workflows/workflow_status.ts:21-28`); v2 takes `id` and returns a
   run record (`tools/workflow_status.ts:7,13`). v1 has `stop_workflow`; v2 has `cancel_workflow`.
   While both surfaces exist, `workflow_status` is ambiguous in any array that merges them.
4. **Defensive validation of a store the module constructs itself.** `this.#store` is created by
   `createWorkflowDatabase(...)` in the constructor (`WorkflowsModule.ts:220`), yet every call goes
   through `Reflect.apply` plus `workflowStorePromise`, which checks the return value is thenable
   before awaiting it (lines 582-657, 753-760), followed by a full `Value.Check` of the result.
   `createWorkflowDatabase` then re-validates its own arguments a second time
   (`WorkflowDatabase.ts:142-147,159-165,205-211,214-221,223-229,245-251`). The compiler already
   guarantees all of it.
5. **A migration that creates two tables so the next one can drop them.**
   `WorkflowsModule.ts:181-198` creates the receipts and proofs tables;
   `002-workflows-drop-replay-evidence` (lines 201-213) drops them, and the constants
   `WORKFLOW_RECEIPTS_TABLE`/`WORKFLOW_PROOFS_TABLE` remain exported
   (`WorkflowDatabase.ts:39-40`). Correct under the immutable-migration rule; still, every fresh
   install creates two tables purely to delete them. Under the early-stage policy this is a
   candidate for a generation reset rather than a carried-forward pair.
6. **Dead change-detection branch.** `#mutate` recomputes a `changed` flag and then asserts the
   runtime agreed with it (`WorkflowsModule.ts:559-562`), duplicating the transition check
   `assertMutationTransition` just performed (lines 857-890). The runtime's `changed` field is
   never trusted for anything and exists only to be rejected.
7. **Formatters invoked for their side effect.** `list` calls `this.formatPageForModel(page)` and
   discards the result (line 328); `logs` calls `this.formatLogsForModel(page)` and discards it
   (line 408). A display function is being used as a validator, and the rendering work is then
   repeated by the tool's `toLLM`.
8. **Cursor correctness asserted three times.** The database computes offsets
   (`WorkflowDatabase.ts:178-201`), `assertWorkflowPage` re-checks the schema
   (`WorkflowStore.ts:160-165`), and `assertExactOffsetCursors` (`WorkflowsModule.ts:1022-1047`)
   recomputes cursor, count, next, and previous from scratch and throws on any disagreement — with
   itself, since one process produced both sides.
9. **Unused parameter.** `workflowFactoryResult(value, label)` never reads `label`
   (`WorkflowsModule.ts:762-766`).
10. **Brittle derived constant.** `MAX_WORKFLOW_STATUS_TEXT_LENGTH = "unavailable".length`
    (line 129) hardcodes that `unavailable` is the longest status literal; a longer status silently
    breaks the row-budget arithmetic at lines 229-242 rather than failing loudly.
11. **Model-facing text is raw identifiers.** `formatRunRow` renders
    `` `${run.id}: ${run.workflow} [${run.status}]` `` (lines 1065-1067) and pages end with
    `prev:N` / `next:N` (lines 1053-1063). With no UI rendering anywhere in the module, enum values
    such as `unavailable` and `timed_out` reach any display unconverted, against AGENTS.md's
    human-readable-text rule.

## What it gets right

- **The read/mutate durability split is thought through and stated.** The three database-only read
  tools are `durable: true, transactional: true` so Agent Base owns their single transaction
  (`tools/list_workflows.ts:17-18`, `tools/workflow_status.ts:16-17`,
  `tools/workflow_logs.ts:16-17`), while the host-crossing tools and `wait_workflow` are
  `durable: false` with the reason argued rather than assumed — an interrupted host operation
  cannot be committed atomically with its tool result (`README.md:18-30`).
- **No transaction is held across the host wait.** `#wait` calls the runtime outside any
  transaction, then opens one short transaction to persist and verify the terminal run
  (`WorkflowsModule.ts:374-396`).
- **Lifecycle is checked as transitions, not states.** `assertMutationTransition` and
  `assertWorkflowMutationFieldsPreserved` (lines 857-915) require terminal cancels to be exact
  no-ops, only paused runs to resume, fields outside the transition to be unchanged, and
  `updatedAt` to advance — invariants v1 did not express at all.
- **Post-commit observation is bounded and cannot fail a committed mutation.**
  `#createEvent`/`#notifyPostCommit` (lines 668-724) run the transactional listener inside the
  transaction, register the post-commit one through `afterCommit`, freeze the event, and truncate
  the reported error to 500 characters with control characters normalized
  (`normalizePostCommitError`, lines 786-801).
- **Every tool is scoped to `scope.agent.id`** at construction (lines 258-266), so an agent cannot
  address another agent's runs by ID.
