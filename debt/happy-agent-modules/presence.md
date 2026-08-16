# Module report: presence

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/presence/`, the v2 rewrite of
Rig's presence implementation (`packages/rig/sources/presence/` is the v1 reference implementation
being replaced), read against root `AGENTS.md` and master plans 00, 06, 11 (presence), 20, 21. Note:
the master plans still name `@slopus/happy-agent-features` and have not yet been updated for the
rewrite into `happy-agent-modules`.

## Summary

The module stores a presence _label_ — one of `online`, `away`, `offline`, `dnd`, `custom` — plus an
optional 240-character message, an optional expiry with fallback, and a set of weekly recurring
windows. It contributes one sentence to the system prompt and exposes `get_presence` (always) and
`set_presence` (opt-in). What the rewrite has not carried over is the thing master plan 11 says
presence is _for_: how long an agent may wait for a human answer. The transactional machinery around
the state is better than v1's; the state itself is poorer.

## Changes from the Rig v1 implementation

- **Regression — a presence state has no behavior.** v1's `Presence` (`presence/types.ts:2-10`)
  carries `answerWaitMs` (`null` = wait indefinitely, `0` = never wait), a model-facing `prompt`, a
  `title`, and an `emoji`. `AWAY_PRESENCE` (`builtInPresences.ts:14-20`) sets `answerWaitMs: 0` and a
  prompt telling the agent to decide on its own. That value drives `describeUnansweredQuestion.ts`,
  which produces the actual text an ask tool returns when presence — not the human — ended the wait.
  v2's `presenceStateSchema` (`PresenceState.ts:39-61`) has `status`, `message`, `effectiveFrom`,
  `expiresAt`, `fallback` and nothing else. Nothing in the module can tell a question how long to
  wait, which is plan 11's central requirement ("Waiting is configured per state. It may be
  unlimited, immediate, or finite"). This is the largest single capability lost in the rewrite.
- **Regression — custom states are a literal, not a definition.** Plan 11: "the human can create
  custom states… A presence state says whether the human is reachable, how long an agent may wait for
  an answer, what the model should be told about the state, and any additional instructions for
  working in it." v1 implements this in `resolvePresences.ts:9-29`, building custom states from
  configuration with per-state `answerWaitMs`, `prompt`, `title`, and `emoji` overrides. v2 models
  "custom" as a single enum member (`PresenceState.ts:10`) whose only distinguishing content is a
  required free-text message. Two different custom states are indistinguishable to an agent.
- **New states without plan backing.** `offline` and `dnd` (`PresenceState.ts:4-9`) appear in no
  master plan. Plan 11 names exactly two built-in states, Online and Away, and says everything else
  is a human-authored custom state. Because v2's states carry no wait semantics, the module cannot
  say how `offline` or `dnd` differ from `away` — so the new states add surface without adding
  meaning.
- **Open rewrite debt — no change notification.** Plan 11: "When it changes during work, the model
  receives a system notice explaining the new state and its instructions." v2 only re-renders one
  line in `instructions` (`PresenceModule.ts:247-251`), which the model sees on the next inference. A
  change mid-turn produces no notice.
- **Open rewrite debt — scheduling coverage.** Plan 11 asks for "recurring periods such as every day,
  weekdays, or weekends, as well as specific dates." `presenceScheduleInputSchema`
  (`PresenceSchedule.ts:12-25`) supports weekly day-of-week windows with a time zone but has no
  representation for a specific date. Temporary states with a chosen fallback are supported and
  correct.
- **New capability — a model-facing `set_presence`.** In v1 presence is the human's, changed through
  the client and persisted by `PresenceStore` (`presence/PresenceStore.ts`); there is no model-facing
  presence tool. v2 lets the model write it. The tool is off by default and its description warns
  against inferring consent (`tools/set_presence.ts:10-11`), which is the right mitigation, but the
  rewrite is moving a human-owned signal into the agent's reach and should be an explicit product
  decision rather than a side effect of porting.

## Findings

1. **Raw enum values reach the model.** `tools/get_presence.ts:31-35` renders
   `Current presence: dnd.` and `Current presence: custom — <message>`. AGENTS.md: "All strings
   displayed to users must be human-readable English… never raw identifiers, internal enum values."
   The module's own `formatPresenceInstruction` (`PresenceModule.ts:430-440`) already maps `dnd` to
   "do not disturb" — the tool bypasses it. `tools/set_presence.ts:23` has the same problem
   (`Presence set to dnd`).
2. **Two divergent formatters for one value.** `formatPresence` (`tools/get_presence.ts:31`) and
   `formatPresenceInstruction` (`PresenceModule.ts:430`) render the same state differently: one says
   "Current presence", the other "Current user presence"; one humanizes `dnd`, the other does not;
   one ends the message with a period, the other does not. A model reading both in the same turn
   sees two contradictory renderings.
3. **Dead exported schemas.** `presenceStoreSchema = Type.Unknown()` and
   `presenceScheduleStoreSchema = Type.Unknown()` (`PresenceStore.ts:13-14`) validate nothing and are
   never referenced outside `sources/index.ts:323-324`, where they are re-exported.
   `presenceReaderSchema` (`PresenceStore.ts:18-26`) exists only to derive `PresenceReader` via
   `Static`, and `assertPresenceContext` (`PresenceStore.ts:43-47`) has no caller anywhere in the
   repository.
4. **`presenceContextSchema` asserts nothing.** `PresenceEvent.ts:12-14` is
   `Type.Object({}, { additionalProperties: true })` — every non-null object passes. It appears in
   `presenceModuleOptionsSchema` and `presenceReaderSchema` as if it were a boundary check. The
   sibling search module made the opposite choice (`additionalProperties: false`) for the same
   `Context` type; both cannot be right, and the rewrite should settle it once.
5. **Schedules are read unbounded on every presence read.** `effectiveSchedule`
   (`PresenceDatabase.ts:188`) calls `list(ctx, { limit: 10_000 })`, ignoring the module's configured
   `maxSchedules` (default 64, `PresenceModule.ts:89`), and constructs a fresh
   `Intl.DateTimeFormat` per schedule per call (`PresenceDatabase.ts:191-197`). `instructions` calls
   `read` on every turn, so this runs on the inference critical path. AGENTS.md: "Keep optional work
   off correctness and interaction critical paths… must have explicit time and size bounds."
   `#readSchedules` also validates against `Type.Array(presenceScheduleSchema, { maxItems: 10_000 })`
   (`PresenceModule.ts:300`), a second bound unrelated to the configured one.
6. **A migration ships a table only to drop it.** `presenceMigrations` creates
   `happy_agent_presence_receipts` in `001-presence` (`PresenceDatabase.ts:41-49`) and drops it in
   `002-remove-presence-receipts` (52-60). Not editing the released migration is correct per
   AGENTS.md; but the early-stage policy prefers advancing the generation and resetting over
   carrying create-then-drop pairs forward, and the README documents the pair as if it were a
   feature (`README.md:52-53`).
7. **Store results are re-validated after the module itself produced them.** `setSchedule`
   (`PresenceModule.ts:202-209`) calls `assertPresenceScheduleResult`, `assertCanonicalSchedule`,
   `sameSchedule`, and a colliding-ID check against a value that `createPresenceDatabase`'s own
   `schedules.set` (`PresenceDatabase.ts:117-132`) constructed one call earlier from the same input
   and already validated. `PresenceStore` is not an injected host boundary — `PresenceStore.ts:16`
   aliases the module's own `PresenceDatabase`. This is validation of a trusted internal contract.
8. **`setTemporary` double-validates and then casts.** `PresenceModule.ts:154-169` asserts the
   temporary input, rebuilds a state object with `as PresenceState`, and hands it to `setPresence`,
   which asserts again. Two `as PresenceState` casts (161-167, 355-371) sit inside a module whose
   stated purpose is schema-checked correctness.
9. **`state()` is an alias for `read()`.** `PresenceModule.ts:101-103` returns
   `await this.read(ctx)` and is documented as "useful to non-agent host callers" — two public names
   for one operation, matching a pattern repeated across these modules.

## What it gets right

The transactional shape is a deliberate improvement over v1 and is careful and correct: `#mutate`
(`PresenceModule.ts:259-282`) runs the decision inside `ctx.inTx`, calls `onEventTransactional`
inside that transaction, registers `onEvent` through stdlib `afterCommit`, and contains post-commit
listener failures so a committed mutation is never reported as a failed tool call (`#notifyPostCommit`,
329-345) — exactly what plan 21 asks for and what AGENTS.md requires of post-commit notification.
Domain no-ops emit no event (`samePresenceState`, 374-386), so listeners do not see phantom changes.
Events are deep-frozen and cloned before delivery. Both tools are `durable: true` and correctly opt
out of Auto review, since neither crosses a sandbox boundary; review is not coupled to elevation
anywhere in the module. The `set_presence` description is a good example of consent guidance written
for a model rather than for a spec.
