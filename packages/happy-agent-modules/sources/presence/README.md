# Presence

Presence records whether the person an agent is working with is online, away, offline, in do not
disturb mode, or using a custom status. It also supports temporary values with fallbacks and
recurring weekly schedules.

`PresenceModule` stores this state in the Agent Base database carried by the current `Context`.
Direct mutations use `ctx.inTx`; the model mutation tool declares `transactional: true`, so Agent
Base commits its state and result together. The module keeps no operation IDs, fingerprints,
receipts, or replay state.

```ts
import { PresenceModule } from "@slopus/happy-agent-modules";

const presence = new PresenceModule({
    allowModelMutation: true,
    maxSchedules: 64,
});
```

## Model surface

`get_presence` reads the effective presence. `set_presence` is exposed only when
`allowModelMutation` is true, and its description requires an explicit user request before the
model changes presence.

The mutation tool is durable and transactional, so Agent Base commits the stored presence and
completed tool result together without a module-owned replay ledger.

The module also contributes the effective presence to system instructions, for example:

```text
Current user presence: away — back tomorrow.
```

## Direct operations

- `read(ctx)` and `state(ctx)` return the effective state at the configured clock instant.
- `setPresence(ctx, input)` stores a state. Setting the same state is an ordinary no-op.
- `clear(ctx)` returns whether a configured state was removed.
- `setTemporary(ctx, input)` stores a state with an expiry and optional fallback.
- `listSchedules(ctx)` returns the bounded recurring schedule catalog.
- `setSchedule(ctx, input)` creates a schedule or returns an existing content-identical schedule.
- `clearSchedule(ctx, id)` returns whether the schedule existed.

Each mutation uses one store transaction. Domain no-ops do not emit events. A real change invokes
`onEventTransactional` inside its mutation transaction and schedules `onEvent` with `afterCommit`;
post-commit listener failures are advisory and may be reported through `onPostCommitError`.

## Storage

Migration `001-presence` creates the presence, schedules, and historical receipt tables. Migration
`002-remove-presence-receipts` drops the obsolete receipt table without rewriting the released
first migration. Current runtime storage contains only presence state and schedules.