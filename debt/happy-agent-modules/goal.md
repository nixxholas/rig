# Module report: goal

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/goal/` compared against Rig's
own goal implementation (`packages/rig/sources/goals/`, `packages/rig/sources/tools/goals/`), root
`AGENTS.md`, and master plans 00, 07, 16, 20, 21.

## Summary

Goal is the module that most closely matches its master-plan description — plan 20 names Goal as the
canonical feature ("a tool plus a hook: when a turn ends and the goal is still set, the feature
sends a special prompt so the model keeps going"), and the module implements exactly that, plus the
shared instance, transactional and post-commit events, and durable tools plan 21 asks for. It is
also a near line-for-line reimplementation of Rig's existing goal code with a large layer of runtime
self-validation added on top: 667 lines in `GoalModule.ts` and 1,229 across the module, against 89
lines in `packages/rig/sources/goals/` plus three small tool files.

## How it differs from Rig's equivalents

- **Same prompt, same normalizer, two copies.** `impl/createGoalContinuationPrompt.ts:7-18` is
  Rig's `packages/rig/sources/goals/createGoalContinuationPrompt.ts:5-19` with one word changed
  ("the active goal" instead of "the active session goal"), and `impl/normalizeGoalObjective.ts:7-17`
  is `packages/rig/sources/goals/normalizeGoalObjective.ts:3-14` verbatim, including the 20,000
  character bound and the error text. Both copies are live: Rig still drives its own copy from
  `packages/rig/sources/session/InMemorySession.ts:9184`.
- **A fourth tool.** Rig ships `create_goal`, `get_goal`, `update_goal`
  (`packages/rig/sources/tools/goals/index.ts:9`). The module adds `clear_goal`
  (`tools/clear_goal.ts:9`), whose own description concedes it is for the case where "the user
  explicitly abandons" a goal — an action the user performs, expressed as a model tool. `update_goal`
  in the same module tells the model "Pausing, resuming, and clearing a goal are controlled by the
  user" (`tools/update_goal.ts:15`) while `clear_goal` hands the model the clear.
- **TypeBox where Rig hand-writes types.** `SessionGoal.ts:11-46` derives the goal types from
  schemas; Rig hand-writes `interface SessionGoal` and a `isGoalStatus` type predicate
  (`packages/rig/sources/goals/SessionGoal.ts:3-8`, `isGoalStatus.ts:3-5`), which is what the
  AGENTS.md runtime-validation rule forbids. The module is on the right side of that rule.
- **No user-facing rendering.** Rig's goal tools carry `toUI` (`tools/goals/create_goal.ts:44`:
  "Started goal: …"). `AgentTool` has no `toUI` (`packages/happy-agent-base/dist/AgentTool.d.ts`),
  so a host rendering these tools has only the raw tool name to show. That is an agent-base
  limitation, not a module defect, but the human-readable line Rig had is lost in the move.

## Findings

0. **The package itself contradicts the plans.** Plans 16 and 21 put ready-made agent capabilities
   in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`. This applies to
   every module in the package and is stated once here rather than repeated in each report.
1. **Durable state does not live in `AgentKV`, despite the naming.** Plan 21 says "Feature state
   must live in the `AgentKV` key-value stores passed to the feature." The module creates its own
   table `happy_agent_goal_state` (`GoalModule.ts:127-142`) behind a class called `GoalDatabase`
   (`impl/goalDatabase.ts:14-56`) reached through a factory called `goalKV` (`impl/goalKV.ts:4-6`).
   The per-run state does use `scope.runKV` (`GoalModule.ts:229`, `245`, `549`), so the module knows
   the supplied store exists; only the durable goal bypasses it. Calling the private table `goalKV`
   makes the deviation read like conformance.
2. **The module validates its own callers' return values at runtime, repeatedly.** `idFactory`,
   `eventIdFactory`, `clock`, `listener`, and `onPostCommitError` are all declared as
   `Type.Function` schemas (`GoalModule.ts:77-107`) and every produced value is re-checked through
   `#factoryValue` (`GoalModule.ts:525-533`) and `#awaitVoidResult` (`GoalModule.ts:553-558`).
   TypeBox cannot check a function's signature — `Type.Function` degrades to "is a function" — so
   the schemas buy nothing the compiler did not already give, while `#awaitVoidResult` will throw
   `"Goal post-commit listener must return void or a Promise<void>."` at any host whose listener
   happens to return a truthy value. `goalFactoryPromiseSchema` (`GoalModule.ts:89-91`) is used as a
   "is this a promise" test, which is what `instanceof Promise` is for.
3. **Option validation reaches into prototypes to work around its own schema.**
   `assertGoalModuleOptions` (`GoalModule.ts:593-613`) detects that a listener is class-backed,
   rebuilds a plain object from `Reflect.get`, and swallows any error into `candidate = undefined`
   so the check fails closed. This exists only because `additionalProperties: false` on
   `goalModuleOptionsSchema` (`GoalModule.ts:109`) rejects ordinary class instances. The workaround
   is more code than the contract it protects.
4. **Persisted-state invariants are fail-closed on the agent's hot path.**
   `readGoalAuthoritativeState` throws when an active goal lacks its lifecycle sidecar or the
   sidecar's goal is not `Value.Equal` to the stored goal (`impl/goalState.ts:66-78`), and
   `beforeAgentLoopTransact` calls it on every loop and rethrows (`GoalModule.ts:232-247`). Any
   drift between the two rows — including a row written by an older build — makes every subsequent
   turn of that agent throw before inference, with a message
   ("An active Goal requires its exact lifecycle sidecar.") that names an internal concept the user
   has never heard of. The lifecycle sidecar duplicates the goal it points at
   (`impl/goalState.ts:22-29`), so the invariant is guarding against a state only this module can
   create.
5. **A stored failure count with a schema that cannot express its own reset.**
   `goalStoredFailureCountSchema` is `{ minimum: 1, maximum: FAILED_TURNS_BEFORE_BLOCKED - 1 }`
   (`impl/goalState.ts:32-35`), so the count is deliberately never persisted at its terminal value —
   correct, but it means the invariant and the control flow in `afterAgentLoop`
   (`GoalModule.ts:273-295`) have to stay in lockstep by hand, and the read path throws if they
   ever drift.
6. **Deep-freeze and structured-clone on every event and every read.** `#event` clones then
   deep-freezes (`GoalModule.ts:518`, `646-650`), `readGoalAuthoritativeState` clones
   (`impl/goalState.ts:83`), `readGoalState`/`readGoalLifecycle` clone (`impl/goalState.ts:96`,
   `118`), `writeGoal`/`writeGoalLifecycle` clone again on the way in (`impl/goalState.ts:108`,
   `127`), and the tools clone once more via `changeGoalStatus` (`GoalModule.ts:417`). The values
   being defended come straight out of `JSON.parse` (`impl/goalDatabase.ts:30`) and are not shared
   with anyone.
7. **The external-wake message ID is a truncated SHA-256 constrained to a lowercase-alnum
   pattern.** `hashMessageId` (`GoalModule.ts:625-634`) hex-digests
   `["goal-external-wake", agentId, lifecycleId, objective, createdAt]`, slices to 31 characters,
   prefixes `g`, and then validates the result against `goalMessageIdSchema`
   (`SessionGoal.ts:20-24`) — a check that cannot fail by construction. Deriving the idempotency
   key from the objective text also means an activation of the same objective at the same
   `createdAt` collides deliberately, which is the intent but is not stated anywhere.
8. **`GoalDatabase.write` takes `ctx` and immediately voids it** (`impl/goalDatabase.ts:33-34`:
   `void ctx;`) before using `ctx.db` on the next line — leftover from an earlier signature.
   `goalDatabase.ts:58` exports `type GoalDatabaseFacade = GoalDatabase`, an alias with no users.

## What it gets right

- The hook shape is exactly plan 20's Goal example, and the continuation is a queued
  `AgentModuleAction` rather than a side-channel send (`GoalModule.ts:300-316`), so the agent loop
  stays the only thing that drives turns.
- The continuation prompt quotes the objective as escaped data inside `<objective>` and tells the
  model not to treat it as instructions (`impl/createGoalContinuationPrompt.ts:9-18`) — the
  prompt-injection boundary is handled deliberately and carries a comment explaining why.
- All four tools declare `shouldReviewInAutoMode: () => false` and none of them requests Full access
  (`tools/*.ts`), which is the correct reading of the AGENTS.md rule: setting your own goal touches
  nothing outside the agent's own store, so review would be noise and elevation would be wrong.
- Failed turns are counted and the goal is blocked after three rather than looping forever
  (`GoalModule.ts:269-295`), and the continuation ID is memoized in `runKV`
  (`GoalModule.ts:535-551`) so a retried turn re-sends the same message identity instead of
  duplicating it.
- Public operations (`goal`, `setGoal`, `changeGoalStatus`, `clearGoal`, `GoalModule.ts:167-203`)
  are available to non-model callers with `ctx` and an agent ID, which is precisely the shape plan
  21 asks for, and external activation wakes the target agent (`GoalModule.ts:465-486`).
