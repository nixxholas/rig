# Module report: scheduling

Reviewed: 2026-08-16. Scope: `packages/happy-agent-modules/sources/scheduling/`, read against root
`AGENTS.md`, the package `README.md`, and master plans 00, 07, 10 (scheduling), 16, 20, 21. Note:
the master plans still name `@slopus/happy-agent-features` and have not been updated for the rewrite
into `happy-agent-modules`.

This report supersedes the 2026-08-15 review, which described a scheduling module built on a
host-supplied scheduler. That design is gone: the module now owns its clock, its timers, its durable
rows, and the act of firing and delivering a scheduled message. Nothing outside the module schedules
anything.

## Shape

- `Scheduling.ts` — TypeBox schemas and the derived types; no behavior.
- `schedulingTime.ts` — duration and instant arithmetic, including the human duration grammar.
- `schedulingFormat.ts` — every string the model reads.
- `SchedulingTimers.ts` — the injectable timer contract, the Node implementation, and
  `SchedulingAlarm`, which re-arms across the 2^31-1 ms `setTimeout` ceiling and only fires once the
  clock has really reached the due time.
- `SchedulingSuspensions.ts` — in-memory per-agent suspensions; a wait resolves `elapsed` on its
  alarm or `interrupted` on an interrupt or a lifetime abort.
- `SchedulingStore.ts` / `SqliteSchedulingStorage.ts` — the durable rows and their append-only
  migrations.
- `SchedulingModule.ts` — the lifecycle that ties them together.

## What holds

The durable-wait lifecycle stages its work correctly: the row is claimed in a short transaction, the
suspension happens outside every transaction, and the terminal row is settled in a second short
transaction, so a long wait never holds a write lock. The result distinguishes `elapsed` from
`interrupted` and reports the milliseconds that actually elapsed, which is what plan 10 requires.

Delivery is idempotent without a receipt ledger: the scheduled message's own cuid2 ID is used as the
Agent Base message ID, and Agent Base accepts a given message ID exactly once. A duplicate fire after
a crash is therefore free.

`beforeStart` recovers pending schedules from the database and re-arms them, so a restart loses
nothing. Because `detach` drops the agent database along with the caller's lifetime, the module
carries the database onto its own long-lived delivery context explicitly, and refuses to start
without one.

Interrupts have three real sources — the module's alarm, `ctx.lifetime` aborting, and the public
`interruptWaits`, which Rig calls from the send and steer HTTP paths — with `messageAccepted` as a
backstop. Delivering a scheduled message also interrupts the recipient's waits.

`schedule_message` addresses any agent whose ID the sender knows, including itself, exactly as plan
10 defines it; knowing the unguessable Agent ID is the capability, so there is no injected
authorization policy. Subagents are excluded by asking `parentOf`, not by a policy object. The
24-hour bound is stated in the tool descriptions the model reads. Model-facing text carries no raw
identifiers. Both wait tools opt out of Auto review and neither requests elevation.

Every regression and finding in the previous report is resolved: the cross-agent target is back, the
duration grammar accepts human text again, `wait_until` accepts loose instants and Unix timestamps,
the barrel files and schema aliases are gone, the duplicate public operations are gone,
shape-sniffing dispatch is gone, the paginated detail stream is gone, and `list_scheduled_messages`
is no longer marked `transactional`.

## Open

1. **`list_scheduled_messages` and `cancel_scheduled_message` still have no plan backing.** Plan 10
   gives the model `wait`, `wait_until`, and `schedule_message`, and assigns cancellation to the
   human: "The user can cancel a scheduled message by hand." The two extra tools are useful and the
   module gates them to non-subagents, but plan 10 should say so before they are treated as settled.
2. **No gym coverage.** Plan 10 behaviour spans the terminal — a wait that a typed message
   interrupts, a scheduled message that arrives in a later turn — and none of it is exercised end to
   end. The module's own 24 tests cover the lifecycle against an in-memory database and a controlled
   clock, which is not the same thing.
3. **`SchedulingModule.ts` remains the largest file in the module.** It is far smaller than the
   1,282 lines the previous report measured, and the extractions above took the mechanical parts
   out, but the wait lifecycle, the schedule lifecycle, and delivery still share one file.
