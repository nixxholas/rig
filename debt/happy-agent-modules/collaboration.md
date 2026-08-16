# Module report: collaboration

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/collaboration/` as the v2 rewrite
of Rig's agent-to-agent surface (`packages/rig/sources/tools/agents/`,
`packages/rig/sources/agent/tools/claude/Agent.ts`, `SendMessage.ts`), judged against the root
`AGENTS.md` and master plans 00, 07, 12, 16, 20, 21.

## Summary

The collaboration module is the rewrite's agent-to-agent surface: a durable collaborator roster,
message log, and reply-obligation system behind six tools. It goes beyond what v1 shipped, and the
core of that expansion is warranted — plan 7 describes agents that never die, are reached by
unguessable Agent ID, and accept follow-ups, and this module delivers the follow-up behavior plan 7
records as a live regression in v1. `interrupt_agent` is the package's best example of the
permission API used correctly. The open questions are the ones the expansion creates: a listable
roster replaces the unguessable-ID access story without a working authorization hook behind it,
`list_agents` fails outright rather than filtering as soon as an unrelated agent exists, and tool
assembly performs a broker round trip and rewrites a tool description every turn.

## Changes from the Rig v1 implementation

- **Follow-up work to a live collaborator now works.** Plan 7 names the inability to send a
  follow-up to a subagent as a live regression in v1. The rewrite fixes it: a collaborator survives
  the end of its task, accepts follow-up messages, and can be interrupted without being destroyed
  (`CollaborationModule.ts:432-462`). This is the module's reason to exist and it is delivered.
- **Discovery is now exposed, where v1 deliberately withheld it.** V1's `agent_info` description
  states outright "This cannot list or search for agents" and `agent_send` "cannot discover or list
  agents and rejects targets that were not inspected first"
  (`packages/rig/sources/tools/agents/agent_info.ts:8-9`, `agent_send.ts:8-9`) — the direct
  expression of plan 7's "The ID is unguessable, so the user has to share these IDs with Rig by
  hand." `list_agents` (`tools/list_agents.ts:19`) enumerates the roster with pagination. The
  unguessable-ID property was the whole access-control story in plan 7; the rewrite substitutes an
  `authorization` callback for it, and that callback is not supplied by the host (finding 1). Until
  it is, this is a net loss of the v1 protection with nothing enforcing the replacement.
- **Reply obligations are new product surface.** V1's model is fire-and-forget steering plus the
  parent's own `Agent`/`SendMessage` lifecycle. The rewrite adds a durable obligation record with
  `pending`/`answered` states, a responder constraint, and a blocking `wait_for_reply`
  (`CollaborationModule.ts:521-582`, `CollaborationMessage.ts`). No master plan asks for it; it
  should be confirmed as intended v2 scope rather than assumed.
- **Permission posture is preserved and improved.** `send_agent_message` carries the same `readOnly`
  switch as v1's `agent_send` `read_only` (`tools/send_message.ts:15` versus
  `packages/rig/sources/tools/agents/agent_send.ts:19-24`) and both declare
  `shouldReviewInAutoMode: () => false`. No tool in the module sets
  `shouldRunInFullAccessInAutoMode`, so review is never conflated with elevation — a deliberate
  improvement over the applets module in the same package.

## Findings

1. **As wired, `list_agents` throws whenever the roster holds an agent the caller does not own.**
   `listAgents` calls `#authorize(ctx, actingAgentId, agent, "list")` for every row
   (`CollaborationModule.ts:370`), and `#authorize` returns early only for self, owner, parent, or
   child (`CollaborationModule.ts:1286-1292`); otherwise, with no `authorization` option configured,
   it throws `Agent "<id>" is not authorized to list agent "<id>".`
   (`CollaborationModule.ts:1293-1298`).
   `packages/happy-agent/sources/modules/agent/loadHappyAgent.ts:384-399` constructs the module with
   `broker` and `modelCatalog` only — no `authorization`. So the listing tool fails outright, rather
   than filtering, as soon as a second unrelated agent exists. Authorization denial inside a list
   should be a filter; here it is a fatal error for the whole page. This is also the missing half of
   the discovery trade above: the roster is exposed and the authorization hook that was supposed to
   bound it is unwired.
2. **The module re-reads and deep-compares whatever the broker and its own store just wrote.**
   `#assertBrokerConfig` reads back the broker's persisted agent configuration and fails if it is
   not `sameValue` with the expected value (`CollaborationModule.ts:1240-1260`);
   `#assertBrokerSelection` does the same for the model selection
   (`CollaborationModule.ts:1262-1276`); `metadataChangedTransact` writes the roster row and then
   reads it back to confirm the store did not substitute it, throwing "Collaboration roster
   substituted metadata." (`CollaborationModule.ts:601-620`). The broker is a typed host dependency
   and the roster is `SqliteCollaborationStorage` in the same directory. This is over-validation of
   trusted internal contracts paid on every create and every metadata change, and the error text
   accuses a component that cannot realistically misbehave.
3. **Tool assembly performs a broker round trip and rebuilds a tool description every turn.**
   `tools` is `async` and calls `#spawnCapacity` (`CollaborationModule.ts:587`), then
   `create_agent`'s description is regenerated from the live model catalog and capacity numbers
   (`tools/create_agent.ts:21-24`, `describeCreateAgentCapability`,
   `CollaborationModule.ts:638-700`). Master plan 16 wants a model's surface to be fixed, explicitly
   written arrays; a tool whose description text changes between turns also defeats provider prompt
   caching and makes the model's view of its own capabilities non-reproducible. Capacity is dynamic
   state and belongs in the tool's *result* or in an error, not in its description.
4. **`disabledProviders` is hardcoded empty at the only call site.** `loadHappyAgent.ts:397` passes
   `disabledProviders: []`, so the catalog rendering branch for disabled providers
   (`CollaborationModule.ts:657-661`) is dead in practice while the module validates and formats it.
5. **Two storage layers, both validating.** `CollaborationStore.ts` (299 lines) defines the storage
   contract with schemas and assertions; `SqliteCollaborationStorage.ts` (426 lines) is the only
   implementation. Every value crossing the seam is validated on both sides — `#readAgent`,
   `#readMessage`, `#readObligation` all re-assert what the store already asserted
   (`CollaborationModule.ts:1329-1450`), and `#validateAgentReferences`
   (`CollaborationModule.ts:1343-1366`) walks the parent chain checking for cycles the module itself
   created.
6. **A create-then-drop migration pair.** Per the README, `001-collaboration` is immutable and still
   creates a receipt table that `002-drop-collaboration-receipts` removes. Same observation as the
   applets module: AGENTS.md's early-stage policy prefers advancing the generation over carrying the
   pair forward.
7. **Message and obligation tables have no retention story.** The README lists
   `happy_collaboration_agents`, `happy_collaboration_messages`, `happy_collaboration_obligations`;
   nothing in the module prunes messages or settled obligations. Every inter-agent message is
   retained forever in the agent database, which AGENTS.md's retention rule speaks to directly. The
   durable message log is new in the rewrite, so the retention question is new with it.
8. **`list_agents` takes a `maxOutputCharacters` argument it discards.**
   `listAgentsTool(collaboration, actingAgentId, _maxOutputCharacters = 8_000)`
   (`tools/list_agents.ts:11-15`) — the parameter is underscored and unused, while the caller passes
   `this.#maxOutputCharacters` (`CollaborationModule.ts:592`). The budget that actually applies is
   the module's own, read inside `formatAgentPageForModel`.
9. **Output-budget fitting is a retry loop over the store.** `listAgents` re-queries the roster with
   a smaller limit until the rendered page fits, up to `limit + 1` attempts, then throws
   "Collaboration roster could not make output-aware page progress."
   (`CollaborationModule.ts:361-387`). Up to 51 database round trips to render one list, and two
   distinct failure messages a model cannot act on.
10. **The permission switch is gated by the module rather than by Auto review.** `readOnly` on send
    and reply triggers a separate `#authorize(..., "permission")` check
    (`CollaborationModule.ts:732-734`) — a genuine and welcome extra gate — but with `authorization`
    unset it reduces to the owner/parent relationship test, and the Auto reviewer never sees the
    action because the tools declare `shouldReviewInAutoMode: () => false`
    (`tools/send_message.ts:19`, `tools/reply_to_message.ts:19`). V1's `agent_send` behaves the same
    way, so this is carried-forward behavior rather than a regression — worth stating explicitly
    rather than leaving implicit.
11. **Master-plan naming.** The master plans place ready-made capabilities in
    `@slopus/happy-agent-features` and have not yet been updated to name `happy-agent-modules`; the
    plans need the user's dictation to catch up with the rewrite direction.

## What it gets right

- **Plan 7's core requirement is met.** A collaborator survives the end of its task, accepts
  follow-up messages, and `interrupt_agent` stops only the current turn while "the collaborator
  remains available and can receive follow-up work later" (`tools/interrupt_agent.ts:23-24`,
  `CollaborationModule.ts:432-462`). Plan 7 names the inability to send a follow-up to a subagent as
  a live regression in v1; the rewrite fixes it.
- **`interrupt_agent` is the correct use of the permission API.** `shouldReviewInAutoMode: () => true`
  with no `shouldRunInFullAccessInAutoMode`, plus a `describeAutoPermissionAction` that says exactly
  what will happen and what will not (`tools/interrupt_agent.ts:28-30`). This is the decoupling
  AGENTS.md asks for, demonstrated in the same package where applets gets it wrong; it is the model
  the other modules should copy.
- Durability is thought through per tool rather than uniformly: broker-backed mutations are
  `durable: true` with the Agent Base `call.id` as the stable external identity
  (`tools/create_agent.ts:27-30`, `tools/send_message.ts:19-24`), while the long external wait is
  `durable: false` (`tools/wait_for_reply.ts:18`) — with the reasoning recorded in the README rather
  than left to be rediscovered.
- Broker calls are kept outside database transactions with a short finalization transaction after
  (README, `CollaborationModule.ts:728-830`), which is the right ordering for an external effect
  that cannot be rolled back.
- The obligation rules are enforced where they belong and their errors are readable: "Only the
  requested responder may answer this obligation.", "A reply must be sent to the requesting agent.",
  "The reply obligation is no longer pending." (`CollaborationModule.ts:747-757`).
- The module ships a 703-line test file (`tests/collaboration/CollaborationModule.test.ts`).
