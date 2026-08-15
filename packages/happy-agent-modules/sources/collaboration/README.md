# Collaboration

Collaboration lets one agent create, message, and wait on durable collaborators. One
`CollaborationModule` instance serves every agent in a collection. The module owns its roster,
messages, and reply obligations in Agent Base's database; the host supplies an external
`CollaborationBroker`.

```ts
const collaboration = new CollaborationModule({
    broker,
    authorization,
});
```

Direct methods take `ctx` and the acting agent ID. `createAgent`, `sendMessage`, `replyMessage`,
each use one transaction for their database work. `waitForReply` uses short validation and
settlement transactions around its broker wait. Public callers may supply explicit agent or
message IDs; an existing ID is a conflict.

## Tools

The module exposes:

- `create_agent`
- `list_agents`
- `send_agent_message`
- `reply_to_agent_message`
- `wait_for_reply`

The broker-backed mutation tools are durable but not transactional. `create_agent` uses the Agent
Base `call.id` as the collaborator ID, and send/reply use it as the message ID. Broker calls run
outside database transactions, followed by a short catalog-finalization transaction. The broker
must reconcile repeated `create`/`send` calls carrying the same stable ID and identical input; this
lets a retry finish catalog persistence after a prior finalization rollback without duplicating
the external effect. A reply obligation uses its message ID as its own stable identity. The module
does not maintain a replay ledger, fingerprint, or call-scoped KV state.

`wait_for_reply` is non-durable because it performs a potentially long external broker wait.
After the broker returns, one short transaction verifies the authoritative persisted obligation.

## Storage

The current tables are:

- `happy_collaboration_agents`
- `happy_collaboration_messages`
- `happy_collaboration_obligations`

Migration `001-collaboration` is immutable and still reflects its released schema. The forward
`002-drop-collaboration-receipts` migration removes its obsolete receipt table. Runtime storage
has no receipt APIs.

Transactional event listeners run beside the state mutation. Post-commit listeners are registered
with `afterCommit`, so observer failures cannot roll back an already committed mutation.
