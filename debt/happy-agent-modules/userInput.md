# Module report: userInput

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/userInput/` compared against
Rig's own ask surface (`packages/rig/sources/agent/tools/claude/AskUserQuestion.ts`,
`packages/rig/sources/tools/userInput/cancel_ask.ts`, `packages/rig/sources/user-input/`,
`packages/rig/sources/presence/`), root `AGENTS.md`, and master plans 00, 16, 20, 21.

## Summary

`UserInputModule` is a 2,700-line reimplementation of Rig's existing ask-the-user capability,
exposing two provider-neutral tools — `request_user_input` and `cancel_ask` — plus a large host
facade (`ask`, `wait`, `answer`, `cancel`, `complete`, `list`/`listPage`, `get`/`getPage`, four
formatters). It gets the important thing right — neither tool enters Auto review, so the
"Auto never interrupts the user for a permission answer" rule is respected — and its outcome model
(`pending`/`answered`/`cancelled`/`away`/`timed_out`) is genuinely better than Rig's looser
`unanswered`. But it duplicates Rig's presence prose verbatim, invents a "legacy" alias for what is
actually Rig's current spelling, overloads one tool with two unrelated jobs, and drops the one
thing the permission model depends on: a trusted-evidence channel for the user's answer.

## How it differs from Rig's equivalents

- **Tool identity.** Rig's asking tool is `AskUserQuestion`, a Claude *vendor* tool whose schema
  matches Claude's native surface exactly (`questions[1..4]`, required `header`, `options[2..4]`,
  `multiSelect`) — `AskUserQuestion.ts:15-28,55-58`. The module invents a neutral
  `request_user_input` handed to every model, with free-form text answers, optional headers,
  1–32 choices, and a 100,000-character Markdown `context`. Under AGENTS.md's vendor/common split
  and plan 16, a per-vendor ask surface is vendor-shaped; this is the "common tool" treatment
  applied to a vendor surface.
- **`ask_id` is not legacy.** `cancel_ask.ts:19-25,32` accepts `ask_id` as "the legacy spelling",
  and the README repeats it (`README.md:30`). Rig's shipping `cancel_ask` uses `ask_id` and only
  `ask_id` (`packages/rig/sources/tools/userInput/cancel_ask.ts:12`). The module renamed the field
  to `requestId` and then carried a compatibility branch for the name it just diverged from. The
  early-stage compatibility rule in AGENTS.md forbids exactly this: "change current schemas …
  directly instead of adding … deprecated aliases."
- **Durability inverted.** Rig's `AskUserQuestion` is `execution: "durable"` with real durable
  persistence (`packages/rig/sources/persistence/session/durableUserInputSave.ts`,
  `queryDurableUserInputs.ts`, `durableUserInputPrune.ts`, `user-input/DurableUserInputCall.ts`).
  The module's is `durable: false` (`tools/request_user_input.ts:44`) even though
  `#createOrResume` (`UserInputModule.ts:500-536`) plus the call ID as request ID already give it
  crash-safe resumption. Plan 21 says "Try to make every tool durable … Whenever that can be
  arranged, arrange it and mark the tool durable." The README declares the opposite as settled
  (`README.md:28`).
- **No trusted-evidence channel.** Rig's tool defines `toTrustedUserEvidence`
  (`AskUserQuestion.ts:140-143`), which is how a real user answer becomes authorization evidence
  for Auto review. AGENTS.md requires that "trusted answers to interactive questions are
  authorization evidence." The module's tools define only `toLLM`; an answer collected through
  `request_user_input` reaches Auto review as ordinary assistant/tool text, which the same rule
  says is *not* user authorization. The interruption boundary is clean, but the evidence boundary
  is missing.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent
   capabilities in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`.
   Per the master-plan rules this is a code-vs-plan contradiction to surface to the user.
2. **`describeUnansweredQuestion` is copied verbatim from Rig.** `UserInputModule.ts:1272-1314`
   reproduces `packages/rig/sources/presence/describeUnansweredQuestion.ts:15-47` sentence for
   sentence, including `formatDuration` and `plural`, down to `"Continue on your own with your best
   judgement."` and the `⚠️` fallback. Two copies of the same user-visible prose will drift.
3. **`request_user_input` is two tools in one.** `tools/request_user_input.ts:21-24,46-52` takes a
   union of "ask a question" and "read a detail page of a past request", discriminated by whether
   `requestId` is present, and returns a union of two unrelated result schemas. Asking a human and
   paging a stored transcript are different actions with different durability and different failure
   modes; Rig keeps reads out of `AskUserQuestion` entirely.
4. **Two different schemas share the name `userInputContextSchema`.** `UserInputRequest.ts:59-62`
   defines it as the bounded Markdown context string; `UserInputEvent.ts:12-14` defines it as the
   opaque `Context` object. `index.ts:46-47` then re-exports the *string* one twice, once aliased
   as `userInputMarkdownContextSchema`, while `UserInputModule.ts` imports the *Context* one from
   `UserInputEvent.js`. A reader cannot tell which `userInputContextSchema` a call site means.
5. **Over-validation of a trusted, locally constructed dependency.** `validateOptions`
   (`UserInputModule.ts:1417-1475`) builds a `methodView` reflection proxy so it can run
   `Value.Check` over `Type.Function` members of the host-supplied broker, presence policy,
   authorization, and listener — objects whose shapes the TypeScript compiler already guarantees at
   the call site. `#store` is worse: it is created by the module's own
   `createSqliteUserInputStorage()` (`UserInputModule.ts:203`), and every result is still re-parsed
   through `assertUserInputRequest`, `assertUserInputPage`, `assertUserInputVoidResult`, cursor
   arithmetic checks, duplicate-ID checks, and filter checks (`listPage`, lines 376-426). This is
   the compute-module finding repeated: runtime validation of an internal contract.
6. **Duplicate parameter spellings inside one query.** `userInputDetailQuerySchema`
   (`UserInputRequest.ts:464-481`) accepts `cursor`/`limit` *and* `detailOffset`/`detailLimit` for
   the same two values, then throws if both are supplied (`UserInputModule.ts:463-465,1340-1343`).
   The comment calls the aliases a match for "the other bounded detail modules" — consistency with
   sibling modules purchased at the cost of a model-facing schema with two ways to say one thing.
7. **Duplicate presence accessors.** `UserInputStore.ts:28-75` declares `isAvailable` *and*
   `state`, plus `subscribe` *and* `onChange` with identical signatures; the module picks whichever
   exists (`UserInputModule.ts:724,987-995`). Four optional members for two capabilities.
8. **Dead schema and function aliases.** `userInputToolInputSchema` = `userInputAskInputSchema`,
   `userInputWaitToolInputSchema` = `userInputWaitInputSchema`, `userInputAnswerInputUnionSchema` =
   `userInputAnswerInputSchema` (`UserInputRequest.ts:347,355,375`), and
   `formatForModel`/`formatPageForModel`/`formatDetailPageForModel` re-exported as bare aliases of
   the `formatUserInput*` functions (`UserInputModule.ts:1143-1145`), all surfaced through
   `index.ts`. The public surface is roughly twice the size of the concept.
9. **A migration that creates two tables so the next one can drop them.**
   `SqliteUserInputStorage.ts:46-63` creates `happy_user_input_receipts` and
   `happy_user_input_proofs`; `002-drop-user-input-idempotency` (lines 66-72) drops both. Correct
   under the never-edit-a-migration rule, but it means every fresh install still creates two tables
   only to delete them, and it is the residue of an abandoned idempotency-ledger design that the
   README now advertises as absent.
10. **Unbounded scan to fit a page.** `fitUserInputPage` (`UserInputModule.ts:1147-1169`) re-renders
    the whole page through `formatUserInputPageForModel` once per candidate row, so fitting a
    50-row page formats up to 50 progressively longer strings. `listPage` then calls the formatter
    a third time on the result (line 425). Fine at 50 rows, quadratic by construction.
11. **`limit`-shaped detail bound derived by subtraction.** `detailModelCharacterLimit`
    (line 1351-1353) computes the page size as `maxOutputCharacters - formatUserInputForModel(...)
    .length - 64`, with `64` an unexplained constant, and calls the formatter again to do it.

## What it gets right

- **The interruption boundary is correct and deliberate.** Both tools declare
  `shouldReviewInAutoMode: () => false` (`tools/request_user_input.ts:45`, `tools/cancel_ask.ts:42`)
  and neither requests elevation, matching Rig's own `AskUserQuestion` and `cancel_ask`. Asking the
  user a product question is kept distinct from a permission review, which is exactly the
  distinction AGENTS.md draws.
- **Terminal outcomes are modelled honestly.** The five-state discriminated union
  (`UserInputRequest.ts:231-297`) carries the fields needed to explain each outcome without
  consulting the transcript, and settlement is single-shot: every mutation re-reads the row inside
  the transaction and returns early if it is already terminal (`answer`, `cancel`, `complete`,
  `#settlePending` — lines 300-305, 336-338, 359-364, 546-548). That is a real improvement on a
  boolean "answered" flag.
- **No transaction is held across the wait.** `wait` reads, releases, waits through the broker
  outside any transaction, then opens a short transaction to settle (`UserInputModule.ts:275-287`,
  `638-781`), with the timer `unref`'d (line 691) and the presence subscription cleaned up in
  `finally` (772-780). Presence changes rearm the deadline while waiting rather than being sampled
  once.
- **Cross-agent access is default-deny.** `#authorize` (lines 920-935) allows self-access and
  otherwise refuses unless an injected policy explicitly permits the specific action, and a
  non-boolean policy result is an error rather than a truthy pass.
- **Post-commit observation cannot undo committed state.** `#announce`/`#notifyPostCommit`
  (lines 586-611) run the transactional listener inside the transaction, register the post-commit
  listener through `afterCommit`, and contain both listener and error-reporter failures — matching
  plan 21's two-callback event shape.
