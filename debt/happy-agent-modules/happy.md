# Module report: happy

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/happy/` compared against Rig's
tool surface (`packages/rig/sources/tools/`), root `AGENTS.md`, and master plans 00, 13, 14, 16, 20,
21.

## Summary

Three invented tools — `notify_happy`, `set_happy_status`, `get_happy_status` — plus two database
tables, an always-on system-prompt sentence, and a host interface. Rig has no equivalent tool; the
sanctioned way for an agent to put something in front of a Happy user is master plan 14's slots
(the status line under the composer is literally the first slot listed) and plan 13's dialogs and
notifications, both of which the product places in Happy 2, and the sibling `slots` module already
implements. This module is a second, parallel channel for the same thing with no plan behind it.

## Relationship to Rig

- **No Rig counterpart.** Nothing under `packages/rig/sources/tools/` sends a notification or sets
  an agent status; the only `notify`-shaped code is workflow-internal
  (`packages/rig/sources/tools/workflows/createWorkflowTool.ts`). So this is not a port of an
  existing Rig capability — it is new surface introduced in the module package.
- **It overlaps the slots design rather than using it.** Plan 14 defines slot entries with a scope,
  an author agent, a description and a purpose, persisted and pushed to the app, with the status
  line as a named slot. `set_happy_status` writes a five-value enum plus a free-text message to a
  private table (`HappyModule.ts:66-73`) with none of that provenance, and the module never
  references the slots module. Two mechanisms now claim "the short status shown for this agent".
- **Permission posture matches Rig's read-only tools** — every tool declares
  `shouldReviewInAutoMode: () => false` and none requests elevation (`HappyModule.ts:227`, `238`,
  `248`). For a notification that is defensible, and notably the module does *not* couple review to
  Full access, which is more than several of its siblings manage. See finding 6 for the caveat.

## Findings

1. **The notifications table grows without bound and is never read.** `notify` inserts a row per
   call (`HappyModule.ts:129-136`); nothing anywhere deletes, prunes, or compacts it. The only
   reader is `listNotifications` (`HappyModule.ts:196-214`), which is not exposed as a tool, not
   called by `packages/happy-agent`, and not called anywhere else in the repository. AGENTS.md:
   "Do not create unbounded … event buffers, transcript caches, image stores, debug directories, or
   live-work rows without an explicit retention, compaction, or backpressure strategy." A
   write-only, unbounded table is the clearest possible instance.
2. **Vestigial idempotency columns.** Both tables carry `operation_id` (`HappyModule.ts:68`, `78`).
   For notifications it is the primary key and is set to the same value as `notification_id`, which
   also has its own `UNIQUE` constraint (`HappyModule.ts:84-85`, written at `133`) — two unique
   indexes over one identical value. For status it is written (`HappyModule.ts:169`, `172`) and
   never selected: `#findStatus` reads it (`HappyModule.ts:260`) into `StatusRow.operation_id`
   (`HappyModule.ts:289`) and `parseStatus` drops it (`HappyModule.ts:321-330`). These are the
   remains of a receipt/replay design the README says the module does not have, left in an
   immutable migration.
3. **Duplicate schemas.** `happyNotificationInputSchema` (`Happy.ts:36-43`) and
   `happyNotificationToolInputSchema` (`Happy.ts:44-51`) are character-for-character identical, as
   are `happyStatusInputSchema` (`Happy.ts:52-58`) and `happyStatusToolInputSchema`
   (`Happy.ts:59-65`). All four are exported from `index.ts:16-22`, so the duplication is part of
   the published surface and will silently drift.
4. **Dead exports.** `MAX_HAPPY_OUTPUT_CHARACTERS` (`Happy.ts:9`) is exported and never referenced
   — every other module in the package uses a `maxOutputCharacters` budget to bound model-facing
   text, and this one defines the constant and then formats without it
   (`HappyModule.ts:348-356`). `checkedHappyHost` (`HappyHost.ts:50-54`) is exported from
   `index.ts:8` and called nowhere.
5. **Re-validating a typed dependency.** `assertHappyHost` (`HappyHost.ts:39-48`) rebuilds the host
   from `candidate?.notify` / `candidate?.setStatus` and checks it against a `Type.Function` schema
   (`HappyHost.ts:16-28`), and the constructor does the same thing twice —
   `materializeOptions` (`HappyModule.ts:302-307`), then `Value.Check(happyModuleOptionsSchema…)`
   (`HappyModule.ts:105`), then `assertHappyHost(checked.host)` (`HappyModule.ts:108`). The host is
   a compile-time `HappyHost` supplied by `packages/happy-agent`; `Type.Function` can only assert
   `typeof === "function"`. Beyond construction, every delivery result the host returns is checked
   again at runtime (`HappyModule.ts:145`, `184`) — this is the "over-validation of trusted internal
   contracts" pattern.
6. **The module is unconditional even though the product has a switch for it.** The config module
   defines `settings.happy_integration` (`config/ConfigModule.ts` settings input and resolved
   `happyIntegration`), but `packages/happy-agent/sources/modules/agent/loadHappyAgent.ts:404`
   constructs `new HappyModule({ host: integrations.happy })` with no gate, and `happyIntegration`
   appears nowhere in `packages/happy-agent/sources`. So `instructions()`
   (`HappyModule.ts:216-217`) injects "Happy is the connected client…" into every system prompt and
   all three tools are offered to every model, whether or not a Happy client exists or the user
   turned the integration off.
7. **`notify_happy` is `durable: false` but `transactional: true`** (`HappyModule.ts:226-227`). The
   README explains the non-durability, and the `afterCommit` ordering is right, but the
   consequence is unstated: an interrupted notification becomes an error tool result while its row
   is already committed, so the table accumulates rows for notifications the model was told failed.
8. **User-facing strings pass enum values straight through.** `formatStatus`
   (`HappyModule.ts:353-356`) renders `working`, `blocked`, `idle` — the raw literals from
   `happyStatusSchema` (`Happy.ts:29-35`) — and `get_happy_status` returns "No Happy status."
   (`HappyModule.ts:250`). These reach the model rather than a person, so the AGENTS.md
   human-readable rule is only lightly engaged, but the same strings are what the host has to show,
   and nothing converts them.
9. **Post-commit errors are silently swallowed when no reporter is configured.**
   `#publishAfterCommit` catches everything and only forwards to `#onPostCommitError`
   (`HappyModule.ts:277-281`); `loadHappyAgent.ts:404` supplies no reporter. A Happy client that
   rejects every delivery produces no signal anywhere.

## What it gets right

- The transaction discipline is correct and clearly reasoned: the database row commits first and
  the external client call is registered with `afterCommit` (`HappyModule.ts:143-146`, `182-185`,
  `267-284`), so a rolled-back agent turn cannot send a notification, and an observer failure cannot
  roll back committed state. This is exactly the ordering AGENTS.md asks for ("Publish external or
  in-memory notifications only after the durable transaction commits").
- `setStatus` compares against the previous row and skips both the write and the event when nothing
  changed (`HappyModule.ts:162-186`), so an agent repeatedly asserting the same status does not
  produce a stream of no-op updates.
- Every string bound is explicit and small (`Happy.ts:3-9`), and rows read back from SQL are parsed
  and validated into typed values rather than trusted (`HappyModule.ts:321-342`).
- The host boundary is genuinely narrow — two methods, `notify` and `setStatus`
  (`HappyHost.ts:16-28`) — so transport, auth, and connection state stay outside the module, which
  is the right split.
