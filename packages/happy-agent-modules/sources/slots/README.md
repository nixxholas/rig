# Slots module

`SlotsModule` owns the persistent catalog for Happy's fixed UI slots. One module instance serves
all agents. Every public method takes the acting agent ID, and the module validates scope,
ownership, pagination, and model-output bounds.

The host supplies the scope resolver and event publisher:

```ts
const slots = new SlotsModule({
    scopeResolver: resolveSlotScope,
    publisher: publishSlotEvent,
});
```

Every public database operation uses the database on `ctx`. Direct mutations use `ctx.inTx`, while
mutation tools set `transactional: true` so Agent Base owns the transaction that covers execution,
validation, rendering, the catalog change, and durable result settlement. `create_slot` uses the
stable cuid2 `call.id` as the entry ID. The module keeps no tool-call ledger, injected transaction,
or manual `call.commit` path.

Read tools remain durable and return bounded pages. Mutation behavior is ordinary domain behavior:
creating an existing ID is a conflict, updating with identical values returns the current entry,
reordering to the current order returns the current catalog, and removing an absent entry returns
`false`.

Events have two stages. `listener.onEventTransactional` runs before the mutation transaction
commits. `listener.onEvent` and `publisher` run through `afterCommit`; failures there are reported
to `onPostCommitError` and cannot turn a committed mutation into a tool failure.

Migration `001-slots` remains immutable. Migration `002-remove-slot-idempotency` drops the two
obsolete auxiliary tables created by that released migration.
