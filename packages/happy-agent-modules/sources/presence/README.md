# Presence

Presence records whether the person an agent is working with is online, away, offline, in do not
disturb mode, or using a configured custom state. Every catalog definition carries its display
identity (`title` and `emoji`), model guidance (`prompt`), and answer wait policy
(`answerWaitMs`). `null` waits indefinitely, `0` continues immediately, and a finite value gives
the user-input broker a bounded answer window.

`PresenceModule` stores a state selection, custom definitions, and schedules in the Agent Base
database carried by the current `Context`. Direct mutations use `ctx.inTx`; the model mutation
tool declares `transactional: true`, so Agent Base commits its state and result together. The
module keeps no operation IDs, fingerprints, receipts, or replay state.

```ts
import { PresenceModule } from "@slopus/happy-agent-modules";

const presence = new PresenceModule({
    allowModelMutation: true,
    catalog: [
        {
            id: "focus",
            status: "custom",
            title: "Focus time",
            emoji: "🎧",
            prompt: "The user is concentrating. Continue independently unless the answer is essential.",
            answerWaitMs: 900_000,
        },
    ],
});
```

An optional `initialState` is written once during module startup when no configured state exists;
its selection is still resolved against the built-in and custom catalog.

## Model surface

`get_presence` reads the effective state and its wait/display guidance. `list_presences` returns
the bounded catalog so a model can choose a custom ID. `set_presence` is exposed only when
`allowModelMutation` is true, and its description requires an explicit user request before the
model changes presence. It accepts either a built-in `status` or catalog `presenceId`, plus an
absolute `until` timestamp and optional `fallbackPresenceId`.

The mutation tool is durable and transactional, so Agent Base commits the stored presence and
completed tool result together without a module-owned replay ledger.

The module contributes the effective state to system instructions, including its default prompt:

```text
Current user presence: Away 🌙. The user is away and cannot be reached. Do not wait for an answer. Decide with your best judgement, keep working, and record anything the user should look at later.
```

## Direct operations

- `read(ctx)` and `state(ctx)` return the effective state at the configured clock instant.
- `userInputState(ctx)` returns `{ answerWaitMs, title, emoji, prompt, changesAt? }`.
- `userInputPolicy` exposes the TypeBox-validated `{ state, subscribe }` seam for UserInput.
- `setPresence(ctx, input)` stores a permanent or temporary catalog selection.
- `clear(ctx)` returns whether a configured state was removed.
- `setTemporary(ctx, input)` stores a state with an expiry and optional fallback.
- `listPresences(ctx)` returns the bounded built-in and custom catalog.
- `setPresenceDefinition` and `clearPresenceDefinition` persist custom catalog entries.
- `listSchedules(ctx)`, `setSchedule(ctx, input)`, and `clearSchedule(ctx, id)` manage recurring
  schedule windows.

Presence changes notify transactional and post-commit listeners. The post-commit user-input
subscription is observational and re-arms a waiting request when the effective state changes.

## Storage

Migration `001-presence` creates the state, schedule, and historical receipt tables.
`002-remove-presence-receipts` drops the obsolete receipt table without rewriting the released
first migration. `003-presence-catalog` adds the persisted custom-definition catalog.
