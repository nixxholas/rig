# Module report: permissions

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/permissions/` as the v2 successor
to `packages/rig/sources/permissions/`, the root `AGENTS.md` "Permissions and security" section, and
master plans 00, 16, 20, 21.

## Summary

The module turns the permission mode Agent Base carries into per-call behavior: refuse a tool that
cannot be contained by the mode, review a call in Auto when the tool says so, elevate only when the
tool separately says the sandbox cannot hold it, and stop a turn that keeps being refused. On the
mechanics of `AGENTS.md` it is the most faithful module in the set — review and elevation are
genuinely separate decisions, nothing dispatches on a tool name, and denial, refusal-loop, and
unproven semantics are all modelled explicitly. The gap is not in the mechanics but in the evidence:
`AGENTS.md` requires Auto review to run against the durable, role-aware transcript with real user
messages preserved as authorization evidence, and this module's reviewer contract carries no
transcript at all.

## Changes from the Rig v1 implementation

- **Regression — the reviewer lost the conversation.** v1's `reviewAutoPermission`
  (`packages/rig/sources/permissions/reviewAutoPermission.ts:17-28`) takes
  `messages: readonly Message[]` and hands them to the review agent alongside the action, which is
  how the "user evidence" rule in `AGENTS.md` is actually satisfied. v2's
  `permissionReviewRequestSchema` (`PermissionReviewer.ts:75-87`) carries only `agentId`, `callId`,
  `tool`, `arguments`, `action`, `mode`, `elevates`, and `signal`. Nothing in the v2 contract
  requires or even permits the reviewer to see user authorization evidence; the module accepts
  `userAuthorization` as a self-reported field on the decision and re-checks it
  (`impl/shouldAllowAutoPermissionReview.ts:7-12`) without ever supplying what it should be derived
  from. This is the one v1 protection the rewrite must restore before it can replace v1.
- **Policy carried over faithfully.** `impl/shouldAllowAutoPermissionReview.ts` preserves v1's
  policy exactly — critical never passes, high needs at least medium authorization.
- **Circuit breaker, restructured.** `impl/permissionRefusalCircuitBreaker.ts` carries over
  `packages/rig/sources/permissions/AutoPermissionDenialCircuitBreaker.ts` with the same three
  constants (3 consecutive, 10 of the last 50) and the same "only the first trip stops the turn"
  rule, restructured to return a status object.
- **Unexplained change — timeout.** v1 uses `AUTO_PERMISSION_REVIEW_TIMEOUT_MS = 90_000` and
  documents it as "matching Codex" (`reviewAutoPermission.ts:11-15`). v2 defaults to 120,000
  (`PermissionsModule.ts:95`) with no stated reason for moving off the Codex-aligned value.
- **Prompt text was copied, not moved.** `impl/permissionModeGuidance.ts:77-91` restates the
  sandbox-limits paragraph v1 still ships in its system prompt (unix socket rule, macOS TCP binding,
  proxy, keychain, and so on) verbatim down to punctuation. Until v1's copy is retired, the two will
  drift and models on the two paths will be told different things about the same sandbox.

## Findings

1. **Auto review has no authorization evidence.** `PermissionReviewer.ts:75-87`. `AGENTS.md` is
   explicit: "Auto review must use the durable, role-aware conversation transcript rather than a
   compacted model-context suffix. Real user messages and trusted answers to interactive questions
   are authorization evidence… Preserve user evidence preferentially within the review budget and
   fail closed when required user evidence… is incomplete." The module's review request cannot carry
   a transcript, so a host implementing `PermissionReviewer` against this contract has no
   module-supplied path to that evidence, and the module has no way to fail closed when it is
   missing. v1 supplied it; the rewrite dropped it. This is the most consequential regression in
   the module.
2. **A failed session kill after a permission reduction is only announced.**
   `PermissionsModule.ts:238-250`. When the mode is reduced, `killAllSessions` runs; if it throws,
   the module emits `permission_mode_cleanup_failed` and continues. Sessions started under the
   wider mode keep running while the agent reports the narrower one. The event exists, so the gap
   was noticed; nothing acts on it, and the option's own doc comment
   (`PermissionsModule.ts:64-67`) says a committed reduction "must always have a host capability
   that can terminate elevated sessions."
3. **The README misstates the constructor and the event set.** `killAllSessions` is required in the
   schema (`PermissionsModule.ts:74`, no `Type.Optional`) but `README.md:86` documents it as
   `options.killAllSessions?`. `README.md:103-106` lists six `PermissionEvent` variants; there are
   seven — `permission_mode_cleanup_failed` (`PermissionEvent.ts:13-20`) is omitted, which is
   precisely the event a host most needs to handle.
4. **Reviewer, listener, and guidance provider are validated twice.** The constructor runs
   `Value.Check(permissionsModuleOptionsSchema, options)` (`PermissionsModule.ts:160`), which already
   contains `permissionReviewerSchema`, `permissionModuleListenerSchema`, and
   `permissionToolGuidanceProviderSchema` — then re-checks all three individually
   (`PermissionsModule.ts:163-180`). Since TypeBox's `Type.Function` check is only a `typeof`
   test, neither pass proves anything the type system has not; the second pass proves it twice.
5. **`PermissionsModule.ts` carries six responsibilities in one 611-line file.** Options validation,
   the decision pipeline, per-agent serialization, the refusal circuit registry, the reviewer race,
   and listener announcement. `AGENTS.md` asks for one coherent piece of behavior per file; the
   `impl/` helpers are already split out, so the remaining concentration is in the class itself.
6. **`#allow` re-reads the circuit three times per call.** `PermissionsModule.ts:407-417` fetches
   the circuit, calls `#terminalRefusal` (which fetches it again), possibly creates it, calls
   `recordAllowed`, and on a `false` return calls `#terminalRefusal` a third time. The control flow
   is hard to follow for what is a two-line decision, and `recordAllowed()` returning `false` is
   only reachable in a state `#terminalRefusal` has already covered.
7. **`status()` always reports `newlyStopped: false`.**
   `impl/permissionRefusalCircuitBreaker.ts:30-37`. The field is part of the returned type but is
   meaningless from this method; only `recordRefusal` can set it. A caller reading
   `status().newlyStopped` gets a value that is structurally valid and semantically empty.
8. **The per-agent maps are only cleared on settle.** `#refusals` and `#decisionTails`
   (`PermissionsModule.ts:155-157`) are keyed by agent ID and cleared in `afterAgentSettled`
   (`PermissionsModule.ts:260-262`) or when a tail matches. An agent that never settles keeps its
   entry for the process lifetime. Bounded by live agent count, so minor, but there is no other
   eviction path.
9. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still name
   `@slopus/happy-agent-features` as the home for ready-made agent capabilities and never mention
   `happy-agent-modules`.

## What it gets right

This module is where the `AGENTS.md` permission contract is most visibly respected, and several
points deserve credit specifically.

Review and elevation are separate decisions, decided from two different tool predicates:
`#needsReview` reads `shouldReviewInAutoMode` (`PermissionsModule.ts:468-474`) and `#elevates`
independently reads `shouldRunInFullAccessInAutoMode` (`PermissionsModule.ts:481-487`), with the
comment stating the rule outright — "an action is elevated only because the tool says this
invocation cannot be carried out inside the sandbox, never because it was reviewed." An approved
elevation is scoped to one execution via `{ type: "run", permissionMode: "full_access" }`
(`PermissionsModule.ts:416`), leaving the agent's mode untouched. `requiresAutoOrFullAccess` is
handled first and refused without a review, because there is nothing to review
(`PermissionsModule.ts:304-316`). Nothing anywhere dispatches on a tool name, prefix, or provider
key.

The failure semantics are exactly the ones `AGENTS.md` asks for. A thrown `shouldReviewInAutoMode`
is treated as needing review, not as needing none (`PermissionsModule.ts:472`). A missing or blank
action description is refused as a tool-definition error rather than papered over with a generic
one (`impl/describePermissionAction.ts:12-26`, `PermissionsModule.ts:321-324`). A denial, a timeout,
and an absent reviewer produce three distinct messages, and the unproven ones say plainly that
nothing judged the action unsafe (`impl/permissionRefusalMessage.ts:44-76`) — the distinction
`AGENTS.md` requires between a refusal and a refusal the reviewer never made. The turn stops itself
after repeated refusals (`PermissionsModule.ts:433-462`), for the stated reason that nothing outside
the agent will break the loop once the user is no longer in it. Reviewer arguments are cloned,
frozen, depth-bounded, and byte-bounded before the reviewer sees them, with the original kept for
execution (`impl/snapshotPermissionArguments.ts:13-27`). Serializing decisions per agent
(`PermissionsModule.ts:270-291`) closes the race where an in-flight call outruns a circuit trip.
Every user-facing string is natural English, and the module persists nothing it does not own.
