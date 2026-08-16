# Module report: modelSwitch

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/modelSwitch/` as the v2 successor
to `packages/rig/sources/agent/impl/createModelSwitchHistoryMessage.ts`, root `AGENTS.md`, and master
plans 00, 04 (inference and compaction), 05, 16, 20, 21.

## Summary

The smallest module in the set and the one with the clearest single job: when Agent Base resets a
conversation because two model configurations are incompatible, put one system message at the head
of the new context saying what changed, that an invisible conversation came before, and — when a
history is available — quote both ends of it and name the tool that can read the rest. No tools, no
storage, one hook. The reasoning in `ModelSwitchModule.ts:60-76` is correct and worth keeping. What
undermines it is that the module's README describes a different design from the one the code
implements, and that the rewrite lost some of v1's budget accounting and overview content.

## Changes from the Rig v1 implementation

- **Same message, restated over the v2 history model.**
  `packages/rig/sources/agent/impl/createModelSwitchHistoryMessage.ts` produces the same
  `<model-switch-history-context>` block with the same wording, the same 4-earliest / 8-latest
  split, the same 32,000-character budget, and the same 1,500-character per-message limit.
  `impl/createModelSwitchNotice.ts` and `impl/createHistoryExcerpt.ts` restate it on `HistoryRecord`,
  which is the right target for v2; `createModelSwitchNotice.ts:25` records the wording lineage
  deliberately.
- **Regression — budget accounting.** v1 subtracts the prefix, headers, and closing tag from the
  32,000-character budget before splitting it (`createModelSwitchHistoryMessage.ts:38-47`). v2 passes
  the full `MAX_EXCERPT_CHARACTERS` to `createHistoryExcerpt` (`ModelSwitchModule.ts:159`) and then
  prepends the prefix and headers afterwards (`createModelSwitchNotice.ts:33-50`), so the finished
  notice always exceeds its own stated bound by the length of the framing.
- **Open rewrite debt — subagent count.** v1's overview reports `subagentCount`
  (`createModelSwitchHistoryMessage.ts:33`); v2 has no equivalent
  (`createModelSwitchNotice.ts:58`), so a model inheriting work that spawned subagents is not told
  they exist.
- **Improvement.** v2 distinguishes an exact archive aggregate from a bounded sample and
  labels the difference in the prompt (`ModelSwitchModule.ts:144-160`,
  `createModelSwitchNotice.ts:53-58`). v1 has no such distinction. This is the rewrite's
  best original idea.

## Findings

1. **The README contradicts the code on the central design decision.** `README.md:25-29` states the
   `history` option "is a direct reference to the class, not a duck-typed reader". The schema is
   exactly a duck-typed reader: `modelSwitchModuleOptionsSchema` uses `historyReaderSchema`
   (`ModelSwitchModule.ts:47-52`) and the constructor calls `assertHistoryReader`
   (`ModelSwitchModule.ts:89`). `README.md:16` also shows `new HistoryModule({ store })`, which
   `historyModuleOptionsSchema` now rejects, and `README.md:91-92` says history persists "through
   its own injected `HistoryStore`", which `HistoryModule` no longer does.
2. **A doc comment describes a check the code does not perform.** `ModelSwitchModule.ts:40-46`
   explains at length that `HistoryModule`'s "only genuinely enumerable own property is its `name`
   field, so checking for `name: "history"` is what a structural TypeBox schema can actually
   observe about the instance". The schema immediately below it (lines 47-52) checks no such thing;
   it checks for `messages` and `stats`. The comment is left over from a design that was replaced.
3. **Defensive re-validation of a module that already validates itself.** `validateHistoryRecords`
   (`ModelSwitchModule.ts:209-232`) re-checks every record `HistoryModule.messages` returns for
   schema conformance, duplicate record IDs, and monotonic positions, and `mergeHistoryRecords`
   (`ModelSwitchModule.ts:240-261`) cross-checks position against record ID for conflicts. The
   comment at lines 203-207 admits the reason: "a subclass, a test double, or an instrumented
   wrapper around a real instance could still return something malformed." That is a hypothetical
   caller, not a real threat model, and `HistoryModule.#readPage` already enforces every one of
   these invariants.
4. **Two nested layers of blanket `catch`.** `#excerpt` wraps everything in `try { ... } catch {
   return {}; }` (`ModelSwitchModule.ts:126-163`) with a second inner `catch` around `stats` (lines
   146-157). The outer rationale is right — rejecting `modelChanged` would leave the agent stuck on
   the old model. But the same `catch` also swallows the validation errors that finding 3 exists to
   raise, so the elaborate checking can only ever degrade silently to "no excerpt", never surface a
   real inconsistency to anyone.
5. **The excerpt reads 200 records to render at most 12.** `EXCERPT_READ_PAGE_SIZE` is 100 per side
   (`ModelSwitchModule.ts:30`), while `createHistoryExcerpt` keeps 4 from the beginning and 8 from
   the end (`impl/createHistoryExcerpt.ts:6-8`). The other 188 records are deserialized, validated,
   merged, sorted, and discarded. Reading 8 and 12 would produce identical output.
6. **`beforeStart` keeps a mutable reference to the whole agent collection.**
   `ModelSwitchModule.ts:83`, `94-97`. It is only used to look up a model's display label
   (`#label`, lines 167-173), and the fallback when no collection is present is already correct.
   Holding `AgentSystemRef` for a label lookup is more coupling than the feature needs.
7. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still name
   `@slopus/happy-agent-features` as the home for ready-made agent capabilities and never mention
   `happy-agent-modules`.

## What it gets right

The failure posture is correct and well argued: a history is optional, an unreadable one costs only
the excerpt, and the notice degrades to an honest statement that an invisible conversation came
before (`ModelSwitchModule.ts:117-125`, `createModelSwitchNotice.ts:37-40`). The module holds no
durable state and says so plainly. `investigate()` (`createModelSwitchNotice.ts:62-73`) is careful
about a real failure mode — a model told it "received a handoff" behaves as if it already knows what
was decided — and instead tells it to investigate, with wording that differs correctly across all
four combinations of tool-available and excerpt-available. Labelling sampled statistics as sampled
rather than presenting them as archive totals (`createHistoryExcerpt.ts:20-25`) is the kind of
honesty about partial data that the rest of the codebase should copy, not the other way round.
