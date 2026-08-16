# Collaboration

Collaboration lets one agent create, message, and wait on durable collaborators. One
`CollaborationModule` instance serves every agent in a collection. The module owns its roster,
messages, and reply obligations in Agent Base's database; the host supplies an external
`CollaborationBroker`.

```ts
const collaboration = new CollaborationModule({
    broker,
    authorization,
    modelCatalog: {
        availableModels,
        disabledProviders,
    },
});
```

`modelCatalog` is optional when the host validates model and effort selections at broker creation
time. When supplied, it is a curated snapshot: disabled providers are rejected and a provider is
required whenever a model ID appears on more than one provider route.

Direct methods take `ctx` and the acting agent ID. `createAgent`, `sendMessage`, `replyMessage`,
each use one transaction for their database work. `waitForReply` uses short validation and
settlement transactions around its broker wait. Public callers may supply explicit agent or
message IDs; an existing ID is a conflict. Creation requires model and effort, optionally
validated against the injected catalog, and accepts an optional provider and service tier. It
carries `context`/`forkTurns` to the host broker for task or parent-context creation. `readOnly`
can force a child into Read only or restore the sender's current permission mode; the broker
receives that sender mode and must enforce monotonic reduction for both creation and messaging.

## Tools

The module exposes:

- `create_agent`
- `list_agents`
- `send_agent_message`
- `reply_to_agent_message`
- `wait_for_reply`
- `interrupt_agent`

The broker-backed mutation tools are durable but not transactional. `create_agent` uses the Agent
Base `call.id` as the collaborator ID, and send/reply use it as the message ID. Broker calls run
outside database transactions, followed by a short catalog-finalization transaction. The broker
must reconcile repeated `create`/`send` calls carrying the same stable ID and identical input; this
lets a retry finish catalog persistence after a prior finalization rollback without duplicating
the external effect. A reply obligation uses its message ID as its own stable identity. The module
does not maintain a replay ledger, fingerprint, or call-scoped KV state.

`wait_for_reply` is non-durable because it performs a potentially long external broker wait.
With an `obligationId` it waits for a directed reply; with an `agentId` it returns the collaborator
status (`running`, `completed`, `error`, `aborted`, or `suspended`, as applicable), run identity,
and bounded current/final output. Observations carry a broker run ID, monotonic version, and
optional update time; delayed or reordered observations are rejected. `interrupt_agent` aborts
only the current turn, preserving the collaborator for later follow-up work, and requires a newer
terminal observation from the broker.

The host broker also supplies the current `canSpawn`, `depth`, `maxDepth`, and optional
`maxActive`/`active` capacity signal. The module validates the signal for the requested parent
immediately before broker creation and includes it with the model-visible creation guidance. The
broker's create operation is the atomic capacity boundary and must re-check depth and active
capacity for that parent.

## Storage

The current tables are:

- `happy_collaboration_agents`
- `happy_collaboration_messages`
- `happy_collaboration_obligations`

Migration `001-collaboration` is immutable and still reflects its released schema. The forward
`002-drop-collaboration-receipts` migration removes its obsolete receipt table, and
`003-collaboration-run-state` adds durable run identity and observation ordering fields. Runtime
storage has no receipt APIs.

Transactional event listeners run beside the state mutation. Post-commit listeners are registered
with `afterCommit`, so observer failures cannot roll back an already committed mutation.
