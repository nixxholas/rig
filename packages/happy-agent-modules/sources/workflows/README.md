# Workflows

A workflow is a Python script that decides which agents to run and in what order. The module runs
that script itself, inside a `@pydantic/monty` sandbox with no filesystem, shell, environment or
network of its own, and starts every agent the script asks for as an ordinary collaborator. There
is no host runtime behind it: execution, checkpointing, and the durable run catalog all live here.

```ts
const workflows = new WorkflowsModule({
    runContext: backgroundLifetime,
    collaboration,
    compute: { resolve: async (ctx, agentId) => await computeModule.resolve(ctx, agentId) },
});
```

`runContext` is where a run lives once the tool call that started it has returned — a workflow
outlives its turn, so it cannot be owned by that turn's context. `collaboration` is the module that
starts the agents. `compute` is optional and used for one thing only: reading a script the model
named by path. Optional `clock`, `eventIdFactory`, `collaboratorIdFactory`, `listener`, the page and
log bounds, and `onPostCommitError` behave as in the other modules.

## How a run executes

The script's `agent`, `parallel` and `pipeline` externals block until their agent has finished. The
sandbox is checkpointed and unloaded at every external-call boundary and freshly restored
afterwards, so model thinking time does not consume the script's own execution budget, and the
checkpoint is written to the database as it is taken.

An agent call creates a collaborator with `reportToCreator: false` and workflow metadata naming the
run and the call index. That flag is what keeps a 200-agent workflow from putting 200 messages into
the calling agent's chat: the workflow collects the answer itself, through its own
`onEventTransact`, `onEvent` and `afterAgentSettledTransact` hooks. The answer is recorded in the
settling transaction, before anything in memory is told about it, so it survives a restart.

Inline scripts are capped at 524,288 characters, arguments are finite-depth JSON capped at 65,536
encoded bytes, and a run may start at most 1,000 agents.

## Pausing and resuming

A run whose process stopped is paused, not lost. `afterStart` finds every run still marked running
by a process that is gone and marks it `paused`. `resume_workflow` continues it from its last
durable checkpoint and reuses the agent answers already stored, so a resumed run does not pay for
the same agent twice. `resumeFromRunId` does the same across runs, for a script that has not
changed.

## Tools

- `run_workflow` starts a workflow from `script` or `scriptPath`.
- `list_workflows` returns a bounded page of runs.
- `workflow_status` reads one run.
- `cancel_workflow` cancels a non-terminal run.
- `resume_workflow` continues a paused run.
- `wait_workflow` waits for a run to settle.
- `workflow_logs` returns a bounded page of the notes a script wrote.

Every tool is scoped to `scope.agent.id`. An inline script is text the model already holds, so
starting one crosses no boundary and Auto does not review it. A `scriptPath` is a file on the
machine, so it is described, reviewed and elevated exactly like any other filesystem read.

## Persistence and migrations

The current tables are:

- `happy_agent_module_workflow_runs`
- `happy_agent_module_workflow_logs`
- `happy_agent_module_workflow_checkpoints`
- `happy_agent_module_workflow_agent_calls`
- `happy_agent_module_workflow_launches`

Migrations `001-workflows-runs` and `002-workflows-drop-replay-evidence` remain immutable.
`003-workflows-execution` adds the checkpoint, agent-call and launch tables this module needs to
run and resume a script itself.

Transactional listeners run inside the mutation transaction. Post-commit listeners are advisory:
their failures are bounded and reported through `onPostCommitError` without changing the already
committed result.
