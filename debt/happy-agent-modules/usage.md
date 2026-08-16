# Module report: usage

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/usage/` (README, `UsageModule.ts`,
`Usage.ts`, `UsageContracts.ts`, `impl/usageDatabase.ts`, `tools/get_usage.ts`) reviewed as the v2 successor
to `packages/rig/sources/tools/providerUsage/`, against root `AGENTS.md` and master plans 00, 16, 20, 21.

## Summary

The smallest and best-proportioned module of the five: one indexed table of usage records, one tool
(`get_usage`) returning an aggregate summary of an agent's token and cost usage, and a `reset`. It has one
serious bug. Retention trims to the newest 500 records *across all agents*, so the figure the README calls
"how much has this agent cost so far" is actually a shared rolling window that a second busy agent can
silently empty — and the code clamps the record count so the discrepancy never shows.

## Changes from the Rig v1 implementation

- **Persistent per-agent accounting (deliberate improvement).** v1's `tools/providerUsage/` surfaces
  provider-reported usage for the session that produced it. v2 records usage durably and can answer across
  turns, which is a genuinely more useful question to be able to ask.
- **A total the storage cannot back (regression in trustworthiness).** v1 never presented a number broader
  than what it had; v2 labels a truncated, cross-agent window as totals (findings 2 and 3). The rewrite
  gained persistence and lost the property that the reported figure means what it says.
- **One tool instead of a per-provider reporting path (simplification).** `get_usage` is the whole surface,
  and it is the right size for the capability — the most restrained tool surface in the package.

## Findings

1. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still place ready-made agent
   capabilities in `@slopus/happy-agent-features` and do not mention `happy-agent-modules`.
2. **The retention trim is global, not per agent.** `record()` (`impl/usageDatabase.ts:168-187`) inserts a
   row and then deletes everything past the newest `MAX_USAGE_RECORDS` rows with no agent predicate:
   `DELETE … WHERE record_id IN (SELECT record_id … ORDER BY finished_at DESC, record_id DESC LIMIT
   9223372036854775807 OFFSET ${MAX_USAGE_RECORDS})`. A busy second agent evicts a quiet first agent's
   history. (The `LIMIT 9223372036854775807` is the SQLite idiom for "offset without limit" and works, but it
   deserves the comment it does not have.)
3. **"Totals" are a window, and the clamps hide it.** `aggregate()` (`impl/usageDatabase.ts:64-166`) sums at
   most 500 records and returns them as totals; `read()` clamps
   `totalRecords: Math.min(MAX_USAGE_RECORDS, totalRecords)` (`:53`) and `reset()` clamps its returned count
   the same way (`:197`). Combined with finding 2, the number a model reports to a user as spend-to-date is
   neither lifetime nor per agent, and nothing in the output discloses that. The clamping suppresses the one
   signal that would reveal the truncation.
4. **Documented default does not match the code.** README:40 says the output budget defaults to 8,000, while
   `Usage.ts` sets `MAX_USAGE_OUTPUT_CHARACTERS = 20_000`.
5. **An accepted-and-ignored argument.** `tools/get_usage.ts` declares `aggregate?: boolean` and its own
   documentation states the tool always returns an aggregate summary regardless of the value. A parameter
   the model can set that provably does nothing is worse than no parameter: it invites the model to believe
   it has requested detail records.
6. **A schema that admits it is a trick.** `usageContextSchema` in `UsageContracts.ts` is
   `Type.Unsafe<Context>(Type.Object({}, { additionalProperties: false }))` with a comment conceding that it
   only passes because `Context`'s state is non-enumerable. Every other module in the package uses an
   `additionalProperties: true` opaque context or `Type.Any()`. This is admitted debt in prose, and it breaks
   the day `Context` gains an enumerable field.
7. **Created-then-dropped table.** Migration `001-usage-records` (`UsageModule.ts:119-179`) creates
   `happy_agent_usage_records` plus an index and an unused `happy_agent_usage_reset_receipts` table, and
   `002-drop-usage-reset-receipts` drops the latter. The retirement is correct — released migrations are
   immutable — but it is the same abandoned-idempotency pattern the slots module carries, so it was built
   twice and dropped twice inside the rewrite.

## What it gets right

The permission shape is exactly right: `get_usage` is `durable: true`, `shouldReviewInAutoMode: () => false`
with no Full-access request — correct for a read of the agent's own accounting — and `target` must equal the
calling agent, so one agent cannot read another's spend. Every dimension is bounded (`MAX_USAGE_RECORDS`,
`MAX_USAGE_GROUPS`, `MAX_USAGE_PAGE_SIZE`, `MAX_USAGE_OUTPUT_CHARACTERS`), storage is a single well-indexed
table rather than a JSON blob, persistence is a real gain over v1, and the module is small enough to read in
one sitting — the one place in this package where the implementation is the size the capability warrants.
