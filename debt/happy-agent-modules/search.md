# Module report: search

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/search/` compared against Rig's
own search surface (`packages/rig/sources/tools/search/`), root `AGENTS.md`, and master plans 00,
05, 16 (tools), 20, 21.

## Summary

The search module exposes seven tools — `web_fetch`, `gemini_web_search`, `claude_web_search`,
`codex_web_search`, `bedrock_web_search`, `grok_web_search`, `grok_x_search` — with vendor-correct
names and Rig-matching permission fields. Underneath, all six search tools are thin argument
renamers over one shared `SearchModule.providerSearch` boundary, one shared
`searchProviderRequestSchema`, one shared `searchPageSchema` return type, and one shared
`formatSearchForModel`. That is precisely the cross-vendor sharing master plan 16 forbids. It is
consumed by `packages/happy-agent` (`loadHappyAgent.ts:38`), not by Rig.

## How it differs from Rig's equivalents

- **What a search *is*.** Rig's `claude_web_search` (`ClaudeWebSearch.ts:72-110`) runs one bounded
  side inference against the vendor's native server tool (`{ name: "WebSearch", server: { type:
  "WebSearch" } }`), verifies the server tool actually ran, and returns `{ query, response,
  sources[], durationSeconds }` — an answer plus citations. `grok_x_search`
  (`GrokXSearch.ts:22-32`) returns `{ query, summary, posts[], durationSeconds }`, a genuinely
  different result shape with a different prompt and different link extraction. The module returns
  the identical `searchPageSchema` (`Search.ts:111-120`) from all six tools and renders all six with
  the same `formatSearchForModel` — a list of bare URLs, one per line
  (`SearchModule.ts:204-234`). No answer, no snippet, no vendor-specific prompt.
- **Shared definition factory in all but name.** Plan 16: "cross-vendor definitions share no schema,
  description, prompt, or definition factory." Every tool file here is the same 40-line template
  differing only in a literal string and one argument alias — `allowed_domains` (Claude/Gemini),
  `domains` (Codex), `include_domains` (Grok) — all funnelled into the same `allowedDomains` field
  (`claude_web_search.ts:35-40`, `codex_web_search.ts:34`, `grok_web_search.ts:34-36`). The vendor
  distinction survives only in the tool name and the `provider` literal passed to a common method.
- **`provider_id` is always optional.** Plan 16: "The tool requires `provider_id` so the model
  chooses the account explicitly. The field is optional only when the current provider is one of
  those routes." Rig implements exactly that — `searchProviderSelection.ts:42-49` makes the field
  required when no default route applies and embeds the available IDs as a schema `enum` plus an
  availability sentence in the description. The module hardcodes
  `provider_id: Type.Optional(Type.String({ minLength: 1, maxLength: 256 }))` in all six tools
  (e.g. `claude_web_search.ts:12`), with no enum, no availability text, and no notion of which
  account is signed in.
- **Tools exist whether or not the vendor is reachable.** Rig's `assembleSearchTools.ts:21-62`
  omits a vendor's tool entirely when it has no configured route, and omits Gemini without an API
  key. The module always returns all seven (`SearchModule.ts:194-202`), and when the host has no
  `searchProvider` implementation it silently downgrades a `claude_web_search` call to the generic
  `backend.search` (`SearchModule.ts:155-162`). The model is told it searched through Claude; it
  did not.
- **`web_fetch` semantics.** Rig's `web_fetch` (`web_fetch.ts:50-58`) takes `{ url, prompt }` and
  answers a question about the page, handling cross-host redirects explicitly. The module's takes
  `{ url, maxCharacters }` and returns raw sliced text (`web_fetch.ts:12`,
  `SearchModule.ts:168-192`). Same name, materially different tool.
- **`bedrock_web_search`** exists in both, but plan 16's enumerated list of ordinary search tools
  (`16-tools.md:29-32`) does not include it. Worth confirming with the user rather than assuming.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made search features in
   `packages/happy-agent-features/sources/search/`; no master plan mentions `happy-agent-modules`.
   Per the master-plan rules this is a code-vs-plan contradiction to surface to the user.
2. **One cross-vendor normalized request schema.** `searchProviderRequestSchema`
   (`Search.ts:97-109`) with a closed `provider` union (`Search.ts:74-81`) is the shared definition
   factory plan 16 rules out. Every tool's `execute` is a field rename into it.
3. **Shared result schema and shared renderer.** `returnType: searchPageSchema` and
   `toLLM: (page) => [{ type: "text", text: search.formatSearchForModel(page) }]` are byte-identical
   across all six search tools. Plan 16: "result schemas, prompts, result handling, presentation, and
   tests may all differ" — here none of them can.
4. **The model gets URLs, not research.** `formatSearchForModel` (`SearchModule.ts:218-232`) emits
   URL-only rows and opportunistically appends ` — title`; `snippet`, `source`, `publishedAt`, and
   `score` are validated into the schema (`Search.ts:55-60`) and then never rendered. A model that
   calls `claude_web_search` must follow up with `web_fetch` on each URL to learn anything, which is
   strictly worse than what Rig returns today.
5. **Over-validation of the backend contract.** `assertSearchPage` (`SearchModule.ts:374-399`) makes
   the injected host backend prove it echoed the trimmed query verbatim, returned canonical
   `URL.href` strings, has no duplicate URLs or ids, has finite scores, and advanced `nextCursor` by
   *exactly* `cursor + results.length` (`assertCursorAdvances`, 432-442). Any real search backend
   that de-duplicates, filters, or skips results across a page boundary now throws instead of
   returning results. `canonicalSearchResultUrl` (419-430) additionally rejects any URL the backend
   did not pre-normalize through `new URL().href`, which rejects ordinary well-formed URLs that
   differ only in trailing-slash or percent-encoding normalization.
6. **`search()` formats a page purely to throw it away.** `SearchModule.ts:113` calls
   `this.formatSearchForModel(page)` and discards the result, so a page whose URLs do not fit the
   output budget is rejected rather than paged. Combined with `MAX_SEARCH_RESULT_URL_LENGTH = 200`
   (`Search.ts:15`), any legitimate result with a longer URL fails schema validation and takes the
   whole page down with it.
7. **Runtime validation of a trusted typed dependency.** `searchBackendSchema`
   (`SearchBackend.ts:22-44`) builds `Type.Function` members with `additionalProperties: false` to
   check that the host passed an object shaped like the module's own TypeScript interface, and
   `runtimeOptions` (`SearchModule.ts:307-324`) exists solely to work around the fact that TypeBox's
   closed-object check cannot see prototype methods — a comment admitting the check is fighting the
   language rather than catching a real defect.
8. **Permission fields are duplicated by hand.** Rig writes the rule once
   (`runtime/networkToolPermission.ts:19-22`) with a comment explaining why: "Written once so a
   third such tool cannot quietly answer differently." The module repeats
   `requiresAutoOrFullAccess: true` / `shouldReviewInAutoMode: () => true` in seven files. The
   values are currently right; nothing keeps them right.
9. **README overstates conformance.** `README.md:29` — "The fixed array matches Rig" — and
   `README.md:39-42` claim the vendor tools route through vendor providers "when the host implements
   it." Neither the argument schemas, result schemas, nor the routing behavior match Rig.

## What it gets right

The permission posture is correct and matches Rig exactly: `requiresAutoOrFullAccess: true` plus
`shouldReviewInAutoMode: () => true`, with review *not* implying Full-access elevation, and a
`describeAutoPermissionAction` on every tool that names the external boundary
("Access: external provider network"). `durable: false` is the right call for billed external work,
and the reasoning is stated. TypeBox is used throughout with types derived via `Static`, per policy.
The "URL is the action identity, never truncate it" principle in `formatSearchForModel` and
`formatFetchForModel` is a genuinely good idea, carefully implemented, and honestly documented. The
module correctly keeps vendor server tools out of the agent runtime, satisfying plan 16's
"server tools stay inside providers" rule.
