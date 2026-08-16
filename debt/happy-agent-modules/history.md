# Module report: history

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/history/` as the v2 successor to
Rig's v1 transcript stack (`packages/rig/sources/tools/read_agent_history.ts`,
`packages/rig/sources/agent/impl/selectChatHistoryPage.ts`, `summarizeChatHistory.ts`,
`messageMatchesChatHistoryFilters.ts`), root `AGENTS.md`, and master plans 00, 16, 20, 21.

## Summary

A durable, append-only agent transcript with one read tool (`read_agent_history`), written from
inside the Agent Base transactions that commit the work being recorded. The design intent — history
is not context, so an incompatible model switch loses context and keeps history — is stated clearly
in `README.md:3-7` and is genuinely carried through the code. The rewrite is sound but heavy:
roughly a third of `HistoryModule.ts` is the module checking its own SQL results, and a whole
injected-store abstraction (`HistoryStore`, `selectHistoryPage`, `messageMatchesHistoryFilters`)
survives as public API with no production consumer after the module moved to its own migrated table
— an intermediate step of the rewrite that was never cleaned up.

## Changes from the Rig v1 implementation

- **The transcript model changed, and for the better.** v1's `read_agent_history`
  (`packages/rig/sources/tools/read_agent_history.ts`) reads a provider-shaped `Message[]` through
  `selectChatHistoryPage` / `summarizeChatHistory` / `messageMatchesChatHistoryFilters`. v2 restates
  the same capability over a provider-neutral `HistoryMessage`, which is what makes the
  "history survives an incompatible model switch" guarantee expressible at all.
- **Storage.** v1's transcript lived in session persistence; v2 owns
  `happy_agent_module_history` through an `AgentModuleMigration` (`HistoryModule.ts:156-183`) and
  keeps in-flight blocks in `scope.runKV`. Keeping pending blocks in run KV rather than a heap map
  is a clear improvement over the v1 arrangement.
- **Search.** v1 filters in memory. v2 pushes filtering into SQL with a pre-folded
  `search_text` column and `LIKE ... ESCAPE '!'` (`HistoryModule.ts:782-798`) — a real improvement,
  though there is no index on `search_text`, so every query is a full scan of the agent's rows.

## Findings

1. **A whole injected-store layer is dead in production.** `HistoryStore.ts:30-51` defines
   `historyStoreSchema` / `HistoryStore`, and `impl/selectHistoryPage.ts` implements host-side paging.
   `HistoryModule` uses neither — it queries its own table directly (`HistoryModule.ts:549-736`). The
   only consumer is `tests/support/InMemoryHistoryStore.ts`. Both are still public API
   (`sources/index.ts:181-186`, `sources/index.ts:204`), so a host can implement a `HistoryStore` that
   the module will never call.
2. **The README documents a constructor option that does not exist.** `README.md:92` says "direct
   host operations use the constructor's `transaction` integration", but
   `historyModuleOptionsSchema` (`HistoryModule.ts:92-114`) has `additionalProperties: false` and no
   `transaction` field; `#direct` is just `ctx.inTx` (`HistoryModule.ts:738-743`). `modelSwitch/README.md:16`
   likewise shows `new HistoryModule({ store })`, which now throws "History module options are invalid."
3. **~100 lines of self-postcondition checking on the module's own SQL.** `HistoryModule.ts:636-735`
   re-validates the page it just built: schema check, count relations, stats consistency, duplicate
   record IDs, monotonic positions, cursor monotonicity, block totals. These once guarded an
   untrusted injected `HistoryStore`; against the module's own queries they are assertions about code
   in the same file, executed on every read. This is the over-validation of a trusted internal
   contract that `AGENTS.md` warns about, and it costs three extra aggregate queries per page
   (`HistoryModule.ts:562-563`, `607`, `613-621`).
4. **`beforeToolCallTransact` does work it throws away.** `HistoryModule.ts:333-344` builds a full
   `tool_call` block, parses the arguments, runs `Value.Check` plus a byte-limit check — and then
   line 345 writes only `call.name` to run KV. The block is discarded. Either the validation belongs
   where the block is actually recorded (`onEventTransactional`) or it should not run here.
5. **Pending blocks are a read-modify-write of the whole array.** `#appendPendingBlock`
   (`HistoryModule.ts:444-460`) reads all pending blocks, validates the new one, and writes
   `[...pending, block]` back. With the `MAX_HISTORY_PENDING_BLOCKS` bound of 2,048
   (`HistoryMessage.ts:26`) a long response performs O(n²) KV work, and each write re-serializes
   every block already buffered.
6. **Every append does a `COUNT(*)` and a `MAX(position)`.** `HistoryModule.ts:484-500`. Both run per
   append, on an unindexed count over the agent's rows, purely to enforce
   `MAX_HISTORY_TOTAL_MESSAGES` (100,000) and to allocate the next position. A monotonic counter row
   or `INSERT ... SELECT MAX+1` would do the same work once.
7. **Hitting the record limit bricks the agent, by default.** `failureMode` defaults to `"propagate"`
   (`HistoryModule.ts:195`), so the "The history module reached its record limit." throw at
   `HistoryModule.ts:491-493` propagates out of `afterInferenceTransact` and rolls back the inference
   transaction. At 100,000 records every subsequent turn fails the same way with no pruning path.
8. **Pruning is documented but not implemented.** `HistoryPage.ts:24-25` describes `position` as "the
   zero-based original position, retained when older records are pruned so cursors stay stable", and
   `README.md:94-95` repeats it. Nothing in the module ever deletes a record. The cursor-stability
   design is real; the retention story it exists for is not.
9. **A constant is duplicated instead of imported.** `HistoryModule.ts:75` writes
   `Type.Array(historyBlockSchema, { maxItems: 2_048 })` while `MAX_HISTORY_PENDING_BLOCKS` is
   imported on line 35 and used on line 450. The two will drift.
10. **`role: "system"` is a filter value nothing ever produces.** `historyRoleSchema`
    (`HistoryMessage.ts:54-59`) and the tool's `roles` argument
    (`tools/read_agent_history.ts:87-102`) both offer `"system"`, but every write path uses
    `"user"`, `"assistant"`, or `"error"` (`HistoryModule.ts:316-321`, `366-371`, `398-411`). Only a
    host calling `record` directly can create one; the tool advertises a filter that normally matches
    nothing.
11. **Tool results are recorded as `role: "assistant"`.** `HistoryModule.ts:366-371`. A reader
    filtering `roles: ["assistant"]` to find what the model _said_ gets every tool result too, and
    `stats.assistantMessages` counts one per tool call, so the overview numbers do not mean what
    their names suggest.
12. **`HistoryReader` validates a typed dependency structurally.** `HistoryReader.ts:18-62` builds a
    `Type.Function` schema and `assertHistoryReader` so `ModelSwitchModule` can check that a
    `HistoryModule` has `messages` and `stats`. TypeBox's `Type.Function` check only confirms
    `typeof === "function"`, so this proves nothing the compiler has not already proved, at the cost
    of a cross-module runtime contract.
13. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still name
    `@slopus/happy-agent-features` as the home for ready-made agent capabilities and never mention
    `happy-agent-modules`.

## What it gets right

The transactional discipline is genuinely good: pending blocks live in run KV and are cleared in the
same transaction that appends their message (`HistoryModule.ts:413-419`, `427-442`), so a crash
cannot commit one side; `afterAgentSettledTransact` flushes an interrupted response rather than
losing it; and `afterCommit` is used correctly so the `onAppend` listener never turns a committed
archive into a failure (`HistoryModule.ts:745-763`). Redacted reasoning is recorded as redacted
rather than fabricated (`HistoryModule.ts:955-960`), and unparseable provider arguments are kept as
their original text instead of being dropped (`HistoryModule.ts:970-985`). The tool's permission
declaration is exactly right for what it does — `shouldReviewInAutoMode: () => false` with no
elevation hook at all (`tools/read_agent_history.ts:155-158`) — and the response is bounded by
characters rather than message count, with `returned_messages` plus both cursors telling the model
precisely what it did and did not see (`impl/formatHistoryPage.ts:28-48`).
