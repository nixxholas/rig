# Module report: scheduling

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/scheduling/` compared against
Rig's scheduling implementation (`packages/rig/sources/scheduling/`), root `AGENTS.md`, and master
plans 00, 07, 10 (scheduling), 16, 20, 21.

## Summary

The module implements durable `wait` / `wait_until` / `schedule_message` over a host-supplied
scheduler, plus two tools plan 10 does not ask for (`list_scheduled_messages`,
`cancel_scheduled_message`). The wait lifecycle is thoughtfully staged — plan and finalize in short
transactions, host claim and suspension outside them — and honours the 24-hour bound. The
`schedule_message` tool, however, deliberately removes the capability plan 10 defines it by: it
cannot target another agent. It is consumed by `packages/happy-agent` (`loadHappyAgent.ts:37`), not
by Rig.

## How it differs from Rig's equivalents

- **`schedule_message` cannot address another agent.** Plan 10: "it sends a message at a scheduled
  time to any agent in the system whose Agent ID the sender knows, including itself." Rig implements
  exactly that — `scheduleMessageTool` takes a required `agent_id`
  (`rig/sources/scheduling/tools.ts:130`) described as "Exact unguessable Agent ID of the recipient."
  The module's model-facing schema has no target at all
  (`schedulingScheduleToolInputSchema`, `Scheduling.ts:234-249`), the tool hardcodes
  `targetAgentId: agentId` (`tools/schedule_message.ts:23`), and both the tool description and the
  README state this as intent ("this tool never accepts a target agent",
  `tools/schedule_message.ts:14`; README:16-17). This is the clearest code-vs-plan contradiction in
  the module.
- **Two invented tools.** Plan 10 gives the model `wait`, `wait_until`, and `schedule_message`, and
  assigns cancellation to the human: "The user can cancel a scheduled message by hand." The module
  adds `list_scheduled_messages` and `cancel_scheduled_message` (`SchedulingModule.ts:216-221`),
  which Rig does not have. Nothing in the plans or in vendor practice justifies them.
- **Duration grammar.** Plan 10 allows "seconds, hours, or days, with several forms." Rig models
  this as flat optional fields plus human text — `{ seconds?, hours?, days?, duration? }` where
  `duration` accepts "90 seconds" or "1h 30m" (`rig/sources/scheduling/tools.ts:7-14`,
  `parseScheduleTime.ts:10-27`). The module models it as an eight-member union crossing
  `{ unit, value }` with `{ seconds }`/`{ minutes }`/`{ hours }`/`{ days }`, and singular with
  plural unit literals (`Scheduling.ts:53-74`) — eight schema branches for four units, with no
  human-readable form.
- **`wait_until` accepts far less.** Plan 10: "takes a date in formats the model can express." Rig
  accepts ISO 8601, RFC 2822, Unix seconds, and Unix milliseconds
  (`rig/sources/scheduling/tools.ts:79-88`). The module's `schedulingInstantSchema`
  (`Scheduling.ts:77-82`) is a strict regex requiring an explicit `Z` or `±HH:MM` offset; a model
  emitting `2026-08-16 09:00` or a Unix timestamp gets a schema rejection rather than a wait.
- **Wait results leak internal identities.** Rig tells the model "The wait ended early because a new
  message arrived after 42 seconds." (`rig/sources/scheduling/tools.ts:58-65`). The module says
  `Wait <waitId> was interrupted; 42 seconds actually elapsed.`
  (`SchedulingModule.ts:354-360`), where `waitId` is the durable tool-call ID. AGENTS.md: user-facing
  text must "never raw identifiers"; there is nothing the model can do with a wait ID, since no tool
  accepts one.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities
   in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`. Per the
   master-plan rules this is a code-vs-plan contradiction to surface to the user.
2. **`SchedulingModule.ts` is 1,282 lines.** AGENTS.md: "A file should hold one coherent piece of
   behavior. Most product code lands at one function per file." This file holds option validation,
   the tool array, five public operations, four host-facing operations, five formatters, wait
   planning/claiming/settlement, schedule planning/cancellation/delivery reconciliation, paging,
   authorization, and event announcement. `ProjectStore.ts` and `SecretsModule.ts` in sibling
   modules follow the same pattern.
3. **Two files that are pure re-export barrels.** `SchedulingWait.ts` (28 lines) and
   `SchedulingMessage.ts` (33 lines) re-export names from `Scheduling.ts` and add nothing. They are
   dead indirection.
4. **Aliases duplicating the same schema under a second name.** `Scheduling.ts:342-345` — "Naming
   aliases keep the host-facing surface discoverable without introducing a second schema" — creates
   `schedulingMessageSchema`, `schedulingMessagePageSchema`, `schedulingMessagePageQuerySchema` as
   aliases of the `schedule*` names, plus type aliases at 365 and 374-375, plus
   `schedulingCancelToolInputSchema = schedulingCancelInputSchema` (257) and
   `schedulingDeliveryOutcomeRequestSchema = schedulingDeliveryOutcomeInputSchema` (340). A comment
   admitting the duplication does not remove it.
5. **Duplicate public operations.** `listSchedule` returns `(await listSchedulePage(...)).schedules`
   (`SchedulingModule.ts:269-275`); `getSchedulePage` wraps `getSchedule`
   (292-316); `cancelSchedule` accepts `SchedulingCancelInput | string` and normalizes
   (252-259). Each is a second name for one behavior.
6. **Result formatting dispatches by shape-sniffing.** `formatForModel`
   (`SchedulingModule.ts:411-426`) runs `Value.Check` against the wait-result, page, and detail-page
   schemas in order and falls through to a cast; `formatScheduleDetailPageForModel` (387-409) does
   the same over a two-member union. AGENTS.md forbids classification systems for tool selection for
   the same reason this is fragile: two schemas that happen to overlap silently pick the wrong
   branch, and adding a field can change which one matches.
7. **A paginated 1,000,000-character "detail" stream for a scheduled message.**
   `schedulingScheduleDetailQuerySchema` / `schedulingScheduleDetailPageSchema`
   (`Scheduling.ts:299-318`) and `getSchedulePage` exist to page through `scheduleDetailText(...)`
   of a record whose message is already capped at 50,000 characters
   (`MAX_SCHEDULING_MESSAGE_LENGTH`, `Scheduling.ts:10`). Neither the plans nor any tool uses it —
   `formatScheduleDetailPageForModel` is reachable only through the host API.
8. **Timestamps and durations are bounded at 8.64e15 ms.** `schedulingTimestampSchema` and
   `durationValueSchema` (`Scheduling.ts:38-46`) admit ~275,000 years. The real 24-hour bound is
   applied separately at `DEFAULT_MAX_WAIT_DURATION` / `DEFAULT_MAX_SCHEDULE_HORIZON`
   (`SchedulingModule.ts:76-78`), so the schema the model sees advertises a range the module will
   reject. Rig states "up to 24 hours" in the tool description itself
   (`rig/sources/scheduling/tools.ts:32`).
9. **`list_scheduled_messages` is `transactional: true` for a read.**
   `tools/list_scheduled_messages.ts:18` opens a write transaction to page a catalog;
   `cancel_scheduled_message`, an actual mutation, is not marked transactional
   (`tools/cancel_scheduled_message.ts`). The README's own rule — "Only database-only tools use
   `transactional: true`; host-backed tools remain unwrapped" (README:34) — explains the second but
   makes the first look accidental.
10. **`#authorize` denies by default when no policy is injected**
    (`SchedulingModule.ts:801-826`), including for the agent's own records, so a host that forgets
    to pass `authorization` gets errors on every cross-agent path. Combined with finding 1 — that
    the tool cannot target another agent anyway — the whole authorization apparatus is reachable
    only from the host API.

## What it gets right

The durable-wait lifecycle is the strongest part of the module and tracks plan 10 closely: the
record is planned and finalized in short transactions while the host claim and the suspension happen
outside any transaction (README:20-21), so a long wait never holds a database write lock; the
terminal record is settled in a second short transaction; and the result distinguishes `elapsed`
from `interrupted` and reports the milliseconds that actually elapsed, which is precisely what plan
10 requires. `reportDeliveryOutcome` (`SchedulingModule.ts:318-352`) is a careful idempotent
reconciliation: it re-reads inside the transaction, returns early when the row is no longer pending,
and refuses to proceed when a retry disagrees with durable state — rather than maintaining a receipt
ledger, which the module explicitly declines to do. Both wait tools correctly opt out of Auto review
and neither requests elevation, so review is never coupled to Full access. Events are frozen,
delivered transactionally and post-commit through `afterCommit`, with post-commit failures contained.
TypeBox is used throughout with types derived by `Static`, per policy.
