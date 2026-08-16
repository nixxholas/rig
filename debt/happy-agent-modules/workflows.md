# Module report: workflows

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/workflows/` compared against
Rig's own workflow surface (`packages/rig/sources/tools/workflows/`,
`packages/rig/sources/workflows/`), root `AGENTS.md`, and master plans 00, 16, 20, 21.

## Summary

`WorkflowsModule` is ~2,000 lines implementing seven tools — `run_workflow`, `list_workflows`,
`workflow_status`, `cancel_workflow`, `resume_workflow`, `wait_workflow`, `workflow_logs` — around
an injected `WorkflowRuntime` the module does not supply and Rig does not implement. Rig already
has a shipping "workflow" concept that means something entirely different (a sandboxed Python
multi-agent orchestration script), and two of the module's tool names collide with Rig's with
incompatible schemas. Most of the module's mass is not the feature: it is defensive re-validation
of a store the module itself constructs, cursor arithmetic asserted three ways, and a logs table
nothing ever writes to.

## How it differs from Rig's equivalents

- **"Workflow" means two different things.** Rig's `Workflow`/`workflow` tool runs a sandboxed
  Python script that coordinates subagents, returns a `runId` and `taskId` immediately, and is
  described in 33 lines of model guidance (`createWorkflowTool.ts:13-45`). The module's
  `run_workflow` starts "a host-managed workflow" named by an opaque string with an opaque string
  input (`tools/run_workflow.ts:13-15`). Nothing in the repository or the master plans defines what
  that host-managed workflow is; the capability has no vendor origin and no product definition.
- **Name collisions.** `workflow_status` exists in both, with different arguments: Rig takes
  `run_id` and returns logs inline (`packages/rig/sources/tools/workflows/workflow_status.ts:21-28`);
  the module takes `id` and returns a run record (`tools/workflow_status.ts:7,13`). Rig has
  `stop_workflow`; the module has `cancel_workflow`. If both surfaces are ever assembled into one
  model's array, `workflow_status` is ambiguous.
- **Invented lifecycle.** Rig's runs are `running`/`completed`/`error`/`stopped`. The module adds
  `queued`, `paused`, and `unavailable`, and a `resume_workflow` tool whose only legal input is a
  paused run (`WorkflowsModule.ts:892-900`). Nothing in Rig can produce a paused workflow, so
  `resume_workflow` is a tool for a state that does not exist.
- **Permission behavior is inverted.** Rig's `Workflow` tool reviews and elevates when it must read
  a script off disk, and explains itself: `shouldReviewInAutoMode`,
  `shouldRunInFullAccessInAutoMode`, and `describeAutoPermissionAction` all keyed on `scriptPath`
  (`createWorkflowTool.ts:85-96`). Every one of the module's seven tools declares
  `shouldReviewInAutoMode: () => false` and defines none of the other three hooks — including
  `run_workflow`, which starts host compute (`tools/run_workflow.ts:18`), `cancel_workflow`
  (`tools/cancel_workflow.ts:18`), and `resume_workflow` (`tools/resume_workflow.ts:18`).

## Findings

1. **Starting host compute is never reviewed.** `run_workflow` hands an arbitrary workflow name and
   input to a runtime whose execution boundary is, by the tool's own description, outside Rig —
   "The host owns runtime, processes, filesystem, and permissions" (`tools/run_workflow.ts:14`) —
   and declares `shouldReviewInAutoMode: () => false`. AGENTS.md reserves `requiresAutoOrFullAccess`
   for exactly this case: "tools such as MCP operations whose external execution boundary cannot be
   enforced by Rig's local sandbox." The sibling `mcp` and `applets` modules in this same package do
   declare it (`sources/mcp/createMcpTool.ts:40`, `sources/applets/tools/create_applet.ts:20-23`);
   workflows does not.
2. **`workflow_logs` can never return a line.** `WORKFLOW_LOGS_TABLE` is created
   (`WorkflowsModule.ts:173-180`) and read (`WorkflowDatabase.ts:254-276`), and there is no `INSERT`
   into it anywhere in the package. The tool, its schema, its cursor arithmetic
   (`assertExactLogPage`, `WorkflowsModule.ts:1003-1020`), its formatter with per-line budget
   division (`formatLogsForModel`, lines 442-468), and its README entry all describe a feature that
   returns an empty page for every input.
3. **Defensive validation of a store the module constructs itself.** `this.#store` is created by
   `createWorkflowDatabase(...)` inside the constructor (`WorkflowsModule.ts:220`), yet every call
   goes through `Reflect.apply` plus `workflowStorePromise`, which checks that the return value is
   thenable before awaiting it (lines 582-657, 753-760), followed by a full `Value.Check` of the
   result. `createWorkflowDatabase` then re-validates its own arguments a second time
   (`WorkflowDatabase.ts:142-147,159-165,205-211,214-221,223-229,245-251`). The compiler already
   guarantees all of it; this is the compute module's finding 4 at larger scale.
4. **A migration that creates two tables so the next one can drop them.**
   `WorkflowsModule.ts:181-198` creates the receipts and proofs tables;
   `002-workflows-drop-replay-evidence` (lines 201-213) drops them. The constants
   `WORKFLOW_RECEIPTS_TABLE` and `WORKFLOW_PROOFS_TABLE` remain exported from
   `WorkflowDatabase.ts:39-40`. Correct under the never-edit-a-migration rule, but every fresh
   install creates two tables purely to delete them, and the README explains the absence of the
   design they belonged to (`README.md:18-26`).
5. **Dead branch in `create`-style change detection.** `#mutate` and `#launch` recompute a `changed`
   flag and then assert the runtime agreed with it (`WorkflowsModule.ts:559-562`), duplicating the
   transition check `assertMutationTransition` just performed (lines 857-890). The runtime's
   `changed` field is thus never trusted for anything and only exists to be rejected.
6. **Formatters invoked for their side effect.** `list` calls `this.formatPageForModel(page)` and
   discards the result (line 328); `logs` calls `this.formatLogsForModel(page)` and discards it
   (line 408). The formatter throws if the rendering would exceed the budget, so a display function
   is being used as a validator, and the rendering work is then repeated by the tool's `toLLM`.
7. **Cursor correctness asserted three times.** The database computes offsets
   (`WorkflowDatabase.ts:178-201`), `assertWorkflowPage` re-checks the schema
   (`WorkflowStore.ts:160-165`), and `assertExactOffsetCursors` (`WorkflowsModule.ts:1022-1047`)
   recomputes the expected cursor, count, next, and previous from scratch and throws on any
   disagreement — with itself, since the same process produced both sides.
8. **Unused parameter.** `workflowFactoryResult(value, label)` never reads `label`
   (`WorkflowsModule.ts:762-766`).
9. **Brittle derived constant.** `MAX_WORKFLOW_STATUS_TEXT_LENGTH = "unavailable".length`
   (line 129) hardcodes that `unavailable` is the longest status literal; adding a longer status
   silently breaks the row-budget arithmetic at lines 229-242 rather than failing loudly.
10. **Model-facing text is raw identifiers.** `formatRunRow` renders
    `` `${run.id}: ${run.workflow} [${run.status}]` `` (line 1065-1067) and pages end with
    `prev:N` / `next:N` (lines 1053-1063). No tool defines a UI rendering, so nothing converts
    `unavailable` or `timed_out`-style enum values into the "human-readable English" AGENTS.md
    requires of displayed text; every Rig workflow tool defines `toUI`
    (`createWorkflowTool.ts:169`, `stop_workflow.ts:28`, `workflow_status.ts:47`).

## What it gets right

- **The read/mutate durability split is thought through and honest.** The three database-only read
  tools are `durable: true, transactional: true` so Agent Base owns their single transaction
  (`tools/list_workflows.ts:17-18`, `tools/workflow_status.ts:16-17`,
  `tools/workflow_logs.ts:16-17`), while the three tools that cross into the host and `wait_workflow`
  are `durable: false` with a stated reason — an interrupted host operation cannot be committed
  atomically with its tool result (`README.md:18-30`). That is the right call, argued rather than
  assumed.
- **No transaction is held across the host wait.** `#wait` calls the runtime outside any
  transaction, then opens one short transaction to persist and verify the terminal run
  (`WorkflowsModule.ts:374-396`).
- **Lifecycle transitions are checked as transitions, not as states.**
  `assertMutationTransition` and `assertWorkflowMutationFieldsPreserved` (lines 857-915) require
  that a cancel of a terminal run is an exact no-op, that only a paused run resumes, that fields
  outside the transition are unchanged, and that `updatedAt` advances. Terminal-state and
  timestamp-ordering invariants are also enforced at the store boundary
  (`WorkflowStore.ts:134-158`).
- **Post-commit observation is bounded and cannot fail a committed mutation.**
  `#createEvent`/`#notifyPostCommit` (lines 668-724) run the transactional listener inside the
  transaction, register the post-commit one through `afterCommit`, freeze the event, and truncate
  the reported error to 500 characters with control characters normalized
  (`normalizePostCommitError`, lines 786-801).
- **Every tool is scoped to `scope.agent.id`** at construction (lines 258-266), so an agent cannot
  address another agent's runs by ID.
