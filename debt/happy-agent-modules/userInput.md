# Module report: userInput

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/userInput/` as the v2 rewrite of
Rig's v1 ask surface (`packages/rig/sources/agent/tools/claude/AskUserQuestion.ts`,
`packages/rig/sources/tools/userInput/cancel_ask.ts`, `packages/rig/sources/user-input/`,
`packages/rig/sources/presence/`), against root `AGENTS.md` and master plans 00, 16, 20, 21.

## Summary

`UserInputModule` is the v2 ask-the-user capability: two tools — `request_user_input` and
`cancel_ask` — plus a host facade (`ask`, `wait`, `answer`, `cancel`, `complete`, `list`/`listPage`,
`get`/`getPage`, four formatters). The rewrite is a real advance on v1's outcome model: five
explicit terminal states replace v1's looser `unanswered`, and settlement is single-shot and
transactional. The open debt is one v1 protection that has not been carried over — the
trusted-evidence path that lets a real user answer count as authorization for Auto review — plus a
handful of rewrite artifacts: v1's prose copied rather than shared, a compatibility alias for a
field the rewrite itself renamed, and one tool carrying two unrelated jobs.

The master plans still name `@slopus/happy-agent-features` and have not been updated for the
`happy-agent-modules` rewrite.

## Changes from the Rig v1 implementation

- **Improvement — terminal outcomes are modelled explicitly.** v1 returned an optional `unanswered`
  string alongside empty answers (`AskUserQuestion.ts:101-113`). v2 uses a five-state discriminated
  union — `pending`/`answered`/`cancelled`/`away`/`timed_out` — where each terminal row carries the
  fields needed to explain that outcome without consulting the transcript
  (`UserInputRequest.ts:231-297`).
- **Improvement — provider-neutral surface with a richer answer shape.** v1's tool was Claude's
  native `AskUserQuestion` (required `header`, `options[2..4]`, choices only —
  `AskUserQuestion.ts:15-28,55-58`). v2 offers one tool to every model, accepts free-form text as
  well as selected labels, and allows 1–32 choices and a bounded Markdown `context`
  (`UserInputRequest.ts:105-206`). Under plan 16 this is the common-tool treatment; whether asking
  is common or vendor-shaped is a product call the rewrite has made deliberately.
- **Improvement — cross-agent access is now a modelled concern.** v1 had no notion of one agent
  reading another's questions. v2 defaults to deny and requires an injected policy to permit a
  specific action (`UserInputModule.ts:920-935`).
- **Open debt — no trusted-evidence path.** v1 defines `toTrustedUserEvidence`
  (`AskUserQuestion.ts:140-143`), which is how a real user answer becomes authorization evidence
  for Auto review. AGENTS.md requires that "trusted answers to interactive questions are
  authorization evidence." v2's tools define only `toLLM` (`tools/request_user_input.ts:54-62`,
  `tools/cancel_ask.ts:48`), so an answer collected through `request_user_input` reaches Auto review
  as ordinary tool text — which the same rule says is *not* user authorization. The interruption
  boundary is carried over correctly; the evidence boundary is not yet.
- **Regression — durability lost.** v1's ask tool is `execution: "durable"` with real durable
  persistence (`packages/rig/sources/persistence/session/durableUserInputSave.ts`,
  `queryDurableUserInputs.ts`, `durableUserInputPrune.ts`, `user-input/DurableUserInputCall.ts`).
  v2 is `durable: false` (`tools/request_user_input.ts:44`) even though `#createOrResume`
  (`UserInputModule.ts:500-536`) plus the call ID as request ID already give it crash-safe
  resumption. Plan 21: "Try to make every tool durable … Whenever that can be arranged, arrange it
  and mark the tool durable." The README states the non-durable choice as settled
  (`README.md:28`).
- **Open debt — no UI rendering.** Every v1 tool defines `toUI`
  (`AskUserQuestion.ts:144-147`, `packages/rig/sources/tools/userInput/cancel_ask.ts:51`). Neither
  v2 tool does, so nothing converts a request's state into the human-readable English AGENTS.md
  requires of displayed text.

## Findings

1. **`ask_id` is treated as legacy while v1 still uses it.** `cancel_ask.ts:19-25,32` accepts
   `ask_id` as "the legacy spelling", and the README repeats it (`README.md:30`). The still-live v1
   tool uses `ask_id` and only `ask_id`
   (`packages/rig/sources/tools/userInput/cancel_ask.ts:12`). The rewrite renamed the field to
   `requestId` and then carried a compatibility branch for the name it had just diverged from —
   the early-stage rule in AGENTS.md forbids exactly this: "change current schemas … directly
   instead of adding … deprecated aliases." Pick `requestId` and drop the union.
2. **v1's presence prose was copied instead of shared.** `UserInputModule.ts:1272-1314` reproduces
   `packages/rig/sources/presence/describeUnansweredQuestion.ts:15-47` sentence for sentence,
   including `formatDuration` and `plural`, down to "Continue on your own with your best
   judgement." and the `⚠️` fallback. Two copies of the same user-visible prose will drift while v1
   is still live.
3. **`request_user_input` is two tools in one.** `tools/request_user_input.ts:21-24,46-52` takes a
   union of "ask a question" and "read a detail page of a past request", discriminated on the
   presence of `requestId`, and returns a union of two unrelated result schemas. Asking a human and
   paging a stored record have different durability and different failure modes; v1 kept reads out
   of the ask tool entirely.
4. **Two different schemas share the name `userInputContextSchema`.** `UserInputRequest.ts:59-62`
   defines it as the bounded Markdown context string; `UserInputEvent.ts:12-14` defines it as the
   opaque `Context` object. `index.ts:46-47` re-exports the *string* one twice, once aliased as
   `userInputMarkdownContextSchema`, while `UserInputModule.ts` imports the *Context* one from
   `UserInputEvent.js`. A reader cannot tell which one a call site means.
5. **Over-validation of trusted, locally constructed contracts.** `validateOptions`
   (`UserInputModule.ts:1417-1475`) builds a `methodView` reflection proxy so it can run
   `Value.Check` over `Type.Function` members of the host-supplied broker, presence policy,
   authorization, and listener — shapes TypeScript already guarantees at the call site. `#store` is
   worse: it is created by the module's own `createSqliteUserInputStorage()`
   (`UserInputModule.ts:203`), and every result is still re-parsed through `assertUserInputRequest`,
   `assertUserInputPage`, `assertUserInputVoidResult`, cursor arithmetic, duplicate-ID checks, and
   filter checks (`listPage`, lines 376-426).
6. **Duplicate parameter spellings inside one query.** `userInputDetailQuerySchema`
   (`UserInputRequest.ts:464-481`) accepts `cursor`/`limit` *and* `detailOffset`/`detailLimit` for
   the same two values, then throws if both are supplied (`UserInputModule.ts:463-465,1340-1343`).
   The comment cites consistency with sibling modules; the cost is a model-facing schema with two
   ways to say one thing.
7. **Duplicate presence accessors.** `UserInputStore.ts:28-75` declares `isAvailable` *and* `state`,
   plus `subscribe` *and* `onChange` with identical signatures; the module picks whichever exists
   (`UserInputModule.ts:724,987-995`). Four optional members for two capabilities.
8. **Dead schema and function aliases.** `userInputToolInputSchema` = `userInputAskInputSchema`,
   `userInputWaitToolInputSchema` = `userInputWaitInputSchema`, `userInputAnswerInputUnionSchema` =
   `userInputAnswerInputSchema` (`UserInputRequest.ts:347,355,375`), and
   `formatForModel`/`formatPageForModel`/`formatDetailPageForModel` re-exported as bare aliases of
   the `formatUserInput*` functions (`UserInputModule.ts:1143-1145`), all surfaced through
   `index.ts`. The public surface is roughly twice the size of the concept.
9. **A migration that creates two tables so the next one can drop them.**
   `SqliteUserInputStorage.ts:46-63` creates `happy_user_input_receipts` and
   `happy_user_input_proofs`; `002-drop-user-input-idempotency` (lines 66-72) drops both. Correct
   under the never-edit-a-migration rule, but every fresh install still creates two tables only to
   delete them — residue of an abandoned idempotency-ledger design the README now advertises as
   absent. Under the early-stage policy this is a candidate for a generation reset rather than a
   carried-forward pair.
10. **Quadratic page fitting.** `fitUserInputPage` (`UserInputModule.ts:1147-1169`) re-renders the
    whole page through `formatUserInputPageForModel` once per candidate row, so a 50-row page
    formats up to 50 progressively longer strings; `listPage` then calls the formatter a third time
    on the result (line 425).
11. **Detail bound derived by subtraction.** `detailModelCharacterLimit` (lines 1351-1353) computes
    the page size as `maxOutputCharacters - formatUserInputForModel(...).length - 64`, with `64` an
    unexplained constant, and calls the formatter again to do it.

## What it gets right

- **The interruption boundary is carried over correctly.** Both tools declare
  `shouldReviewInAutoMode: () => false` (`tools/request_user_input.ts:45`, `tools/cancel_ask.ts:42`)
  and neither requests elevation, matching v1. Asking the user a product question stays distinct
  from a permission review, which is exactly the distinction AGENTS.md draws.
- **Settlement is single-shot.** Every mutation re-reads the row inside the transaction and returns
  early if it is already terminal (`answer`, `cancel`, `complete`, `#settlePending` — lines
  300-305, 336-338, 359-364, 546-548), so a duplicate answer or a racing timeout cannot overwrite a
  committed outcome.
- **No transaction is held across the wait.** `wait` reads, releases, waits through the broker
  outside any transaction, then opens a short transaction to settle
  (`UserInputModule.ts:275-287`, `638-781`), with the timer `unref`'d (line 691) and the presence
  subscription cleaned up in `finally` (772-780). Presence changes rearm the deadline while waiting
  rather than being sampled once — a capability v1 did not have.
- **Cross-agent access is default-deny** and a non-boolean policy result is an error rather than a
  truthy pass (`#authorize`, lines 920-935).
- **Post-commit observation cannot undo committed state.** `#announce`/`#notifyPostCommit`
  (lines 586-611) run the transactional listener inside the transaction, register the post-commit
  listener through `afterCommit`, and contain both listener and error-reporter failures — plan 21's
  two-callback event shape, implemented.
