# Workflows

Workflows lets an agent start and inspect work performed by a host runtime. The module owns the
durable run catalog, bounded reads, lifecycle validation, and model-facing formatting. The host
runtime owns execution, processes, files, queues, and permissions.

```ts
const workflows = new WorkflowsModule({
    runtime: hostWorkflowRuntime,
});
```

`runtime` implements `launch`, `cancel`, `resume`, and `wait`. Database operations use the root or
active transaction facade from `ctx.db`; short persistence steps compose through `ctx.inTx(...)`.
Optional factories control public operation and event IDs; optional listeners observe lifecycle
events.

## Durable tool completion

The module does not maintain an idempotency ledger. There are no workflow fingerprints, receipts,
mutation proofs, or call-scoped operation records.

`run_workflow`, `cancel_workflow`, and `resume_workflow` pass the stable Agent Base `call.id`
directly to the runtime as `operationId`. The host operation runs outside a database transaction;
the module then stores its returned run in a short transaction. These tools are non-durable because
an interrupted host operation cannot be atomically committed with its durable tool result.

`wait_workflow` is likewise non-durable and never holds a database transaction while waiting on
the host broker. Once the broker returns, the module opens one short transaction that persists the
terminal run.

The bounded database-only read tools are durable and `transactional: true`, so Agent Base owns
their single transaction and commits their returned result normally.

Public `launch`, `cancel`, and `resume` calls may supply `operationId`; otherwise `idFactory`
generates one. Reusing an existing launch ID is a conflict, not a module replay path.

## Tools

- `run_workflow` starts one named workflow.
- `list_workflows` returns a bounded page of runs.
- `workflow_status` reads one run.
- `cancel_workflow` cancels a non-terminal run.
- `resume_workflow` resumes a paused run.
- `wait_workflow` waits for a terminal or unavailable result.
- `workflow_logs` returns a bounded page of log lines.

Every tool is scoped to `scope.agent.id`. Inputs, runtime results, persisted results, pagination,
and lifecycle transitions are validated before they reach the model.

## Persistence and migrations

The current tables are:

- `happy_agent_module_workflow_runs`
- `happy_agent_module_workflow_logs`

Migration `001-workflows-runs` remains immutable. Migration
`002-workflows-drop-replay-evidence` removes the obsolete receipt and proof tables introduced by
the first migration.

Transactional listeners run inside the mutation transaction. Post-commit listeners are advisory:
their failures are bounded and reported through `onPostCommitError` without changing the already
committed result.
