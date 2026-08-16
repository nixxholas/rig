# Permissions

The mode an agent runs in, enforced. `@slopus/happy-agent-base` carries the permission mode —
`read_only`, `workspace_write`, `auto`, `full_access` — on every context and makes changes to it
durable, but it enforces nothing, because the base runtime cannot know what any particular tool
touches. `PermissionsModule` is what turns the mode into behavior: it decides, per tool call,
whether the call may run at all, whether it needs a review, and whether an approved call gets to
run with the sandbox lifted for its own length.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { PermissionsModule, permissionModeChangeNotice } from "@slopus/happy-agent-modules";

const permissions = new PermissionsModule({
    reviewer,
    listener,
    toolGuidanceProvider: activeToolGuidance,
    killAllSessions,
    reviewTimeoutMs: 120_000,
});
const agent = await Agent.create(ctx, { ...options, modules: [permissions] });

await agent.steer(
    ctx,
    { role: "user", content: [{ type: "text", text: permissionModeChangeNotice("read_only") }] },
    { permissionMode: "read_only" },
);
```

The module never owns the mode itself. The mode belongs to the agent, which carries it, persists
its changes, and hands it to every hook; changing it means steering the agent a message that says
so, which is `permissionModeChangeNotice(mode)`. That is what makes a new mode take effect exactly
where the conversation shows it did, never mid-response or mid-batch.

## Tools

This module provides no tools of its own. Instead it installs two `AgentModule` hooks that act on
every tool call any other module offers, and one hook that supplies the model's instructions:

- `instructions(ctx, scope)` returns `permissionModeGuidance(scope.agent.permissionMode, tools)`.
  It includes the mode rules, the sandbox limits, and (in Auto) the deduplicated
  `autoPermissionInstructions` declared by the active tools. Agent Base keeps its merged tool list
  private, so `toolGuidanceProvider(ctx, agentId)` is the narrow host-supplied source for those
  prompt fields.
- `beforeToolCall(ctx, scope, call)` is where every decision is made. It returns `undefined` to let
  a call run unchanged, `{ type: "run", permissionMode: "full_access" }` to let it run elevated for
  that one call, or `{ type: "answer", content: [...], isError: true }` to refuse it with an
  explanatory message the model reads as the tool's result.
- `permissionModeChanged` / `permissionModeChangedTransact` announce a mode change to the listener,
  report a failed host cleanup when one occurs, and `afterAgentSettled` clears the per-agent
  refusal circuit once a run ends.

The decision in `beforeToolCall` is read entirely off the tool being called, never off a list of
tool names:

1. If `tool.requiresAutoOrFullAccess === true` and the mode is `read_only` or `workspace_write`,
   the call is refused without a review — there is nothing to review, since the tool cannot be
   contained by the sandbox at all.
2. Outside `auto`, nothing is reviewed and nothing is elevated; the mode simply travels on the
   context and the tools that act on the machine obey it.
3. In `auto`, `tool.shouldReviewInAutoMode(args, ctx)` decides whether this invocation needs a
   review. A predicate that throws is treated as needing one. If it doesn't, the call runs as-is.
4. If it does, `tool.describeAutoPermissionAction?.(args, ctx)` and
   `tool.shouldRunInFullAccessInAutoMode?.(args, ctx)` are read. A missing or blank action
   description is a tool-definition error and is refused without inventing a generic action. The
   request then goes to the configured `PermissionReviewer`.
5. An `allowed` decision is checked again by the independent Auto policy: critical risk is never
   allowed, and high risk requires at least medium user authorization. A policy-rejected or
   reviewer-denied decision produces a final refusal. A decision that never came back (no reviewer,
   a thrown error, or a timeout) produces an unproven refusal.

A denial and an unproven review are told to the model as different things: a denial is final and
must not be routed around, while an unproven review decided nothing. A timeout permits one retry or
asking the user how to proceed; an unavailable reviewer directs the model to work without that
permission or ask the user. Refusals in a row (`refusalsBeforeStopping`, default 3), or 10 refusals
within the last 50 permission decisions, end the turn by calling `agents.abort(ctx, agentId)`.
Allowed calls clear only the consecutive streak, not the bounded long-window rate.

## External functions

- `new PermissionsModule(options: PermissionsModuleOptions)` — constructs the module.
  `options.reviewer?: PermissionReviewer` decides Auto reviews; without one, every action that asks
  for review is refused as unproven. `options.listener?: PermissionModuleListener` is told about
  every mode change and decision. `options.toolGuidanceProvider?: PermissionToolGuidanceProvider`
  supplies the current tools' Auto guidance because Agent Base does not expose the merged tool
  list to module instructions; `toolGuidance?: PermissionToolGuidances` is the fixed-list variant.
  `options.killAllSessions: (ctx, agentId) => Promise<void> | void` is the required host Compute
  seam called after a committed permission reduction; a failed cleanup is reported as
  `permission_mode_cleanup_failed`. `options.reviewTimeoutMs?: number` bounds how long a review
  may take (default 120,000ms) before it counts as unanswered.
  `options.refusalsBeforeStopping?: number` sets the consecutive limit (default 3). One instance
  serves every agent in a collection, keeping only bounded in-memory refusal circuits per agent.
- `PermissionReviewer.review(ctx, request: PermissionReviewRequest): Promise<PermissionReviewDecision>`
  is the contract a host implements. `PermissionReviewRequest` carries `agentId`, `callId`, the
  resolved `tool`, its detached and bounded `arguments`, the `action` description, the `mode`
  (always `auto`, the only mode that reviews), `elevates` (whether an approval also lifts the
  sandbox), and an `AbortSignal` in `signal` that is aborted when the bounded review times out.
  `PermissionReviewDecision` carries `risk` and `userAuthorization` on an allowed result (they
  may also be supplied on a denial). The reviewer reports them, while the module independently
  rejects critical risk and high-risk actions without medium-or-higher authorization. Review must
  never become a question put to the person and must answer in bounded time.
- `PermissionModuleListener` has two optional callbacks that both see every `PermissionEvent`, but
  at different points: `onEventTransactional(ctx, event)` runs inside the transaction that commits a
  mode change, before it commits, so a listener's own record of the change is committed with it (and
  its failure rolls both back). `onEvent(ctx, event)` runs once a change is durable, and it is the
  only callback called for per-call decisions, which commit nothing. `PermissionEvent` is a
  discriminated union: `permission_mode_changed`, `permission_mode_cleanup_failed`,
  `permission_action_reviewed`, `permission_action_denied`, `permission_action_unproven`,
  `permission_action_out_of_mode`, and `permission_turn_stopped`.
- `permissionModeGuidance(mode: AgentPermissionMode, tools?: PermissionToolGuidance[]): string`
  returns bounded instructions for a mode. It includes the sandbox limits for restricted modes and
  deduplicates every Auto tool guidance string.
- `permissionModeChangeNotice(mode: AgentPermissionMode, tools?: PermissionToolGuidance[]): string`
  returns the message to steer at the agent when changing its mode, carrying the announcement and
  the same rules paragraph.

## Storage

The module persists nothing. It keeps no state in `AgentKV`, `sharedKV`, `runKV`, or any
call-scoped store, and it takes no store of its own in its constructor. It holds only static tool
guidance and a private bounded refusal circuit per agent. A circuit has a consecutive count plus
the last 50 decisions; one allowed call clears only the consecutive count, and the entire circuit
is cleared when the agent's run settles (`afterAgentSettled`) or the process restarts. The mode
itself — the thing this module enforces — is not this module's to persist; it lives on the agent
(`scope.agent.permissionMode`) and its durability is `@slopus/happy-agent-base`'s responsibility,
not this module's. Anything durable about permission decisions — an audit log, a review history —
is the host's own responsibility, built on top of the events the module reports through
`PermissionModuleListener`.
