# Module report: systemPrompt

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/systemPrompt/` (README,
`SystemPromptModule.ts`, `SystemPromptSelection.ts`, `AgentsMd.ts`, `impl/`, `prompts/`) reviewed as the v2
rewrite of `packages/rig/sources/agent/prompt/` and `agent/impl/reconcileAgentsMdMessages.ts`, measured
against captured vendor truth in `packages/happy-providers/sources/vendors/*/prompts/` and against root
`AGENTS.md` and master plans 00, 07, 16, 20, 21.

## Summary

The module picks a system prompt per model, fills two placeholders, and appends AGENTS.md content. The
AGENTS.md semantics are the strongest part of the rewrite. The serious problem is upstream of them: the
prompts shipped in `prompts/` have drifted from the captured vendor text they claim to be, which AGENTS.md
forbids regardless of which implementation ships them. The rewrite also reverses v1's deliberate decision
to keep AGENTS.md documents out of the system prompt, and then delivers the same documents a second time as
a hidden steering message.

## Changes from the Rig v1 implementation

- **Per-model prompt files instead of one assembled prompt (design change).** v1's
  `agent/prompt/createSystemPrompt.ts` assembles a single prompt from `AgentContext` — spec, skills,
  plugins, available models, collaboration, workspaces, docs, generated media, tool instructions,
  permissions, protected paths, secrets, `appendSystemPrompt`. v2 keeps whole prompt files per model and
  selects one (`impl/systemPromptForModel.ts`: `promptsByModel` for four Anthropic ids, `promptsByVendor`
  for claude/codex/grok, `vendorsByModelPrefix` for `anthropic/`/`openai/`/`xai/`, else
  `simple_system_prompt`). Selecting a vendor-shaped prompt is defensible; it makes fidelity to the captured
  vendor text the load-bearing property, which is finding 2.
- **AGENTS.md moved into the system prompt (regression).** v1 kept AGENTS.md documents out of the prompt on
  purpose; the inline comment in `createSystemPrompt.ts` says system messages are positional notices
  delivered in the conversation and folding one into the prompt "would move it away from the turn it belongs
  to and rewrite the cached prefix on every notice." v1 delivered them as conversation records via
  `agent/impl/reconcileAgentsMdMessages.ts` + `loadAgentsMdInstructions.ts`. v2 puts them in the prompt
  (`SystemPromptModule.instructions`) **and** still emits the hidden steering user message with the entire
  body (`impl/agentsMdInstructions.ts:276-329`, `${REPLACEMENT_NOTICE}\n\n${loaded.body}`). The same text is
  sent twice per turn and the cached prefix is rewritten whenever any AGENTS.md changes.
- **Security-file location changed (behavior change, undocumented).** v1 read `AGENTS_SECURITY.md` from
  `fs.cwd`; v2 reads it from the git root (`impl/agentsMdInstructions.ts:206-211`). For a repo whose
  security file sits in a subdirectory the two disagree about which rules are in force, and nothing in the
  README explains the change.
- **Environment assembly and helpers carried over unchanged (open rewrite debt).** `impl/trimIndent.ts` is
  byte-identical to `packages/rig-execution/sources/prompts/trimIndent.ts`, and
  `impl/assembleEnvironmentPrompt.ts` is a 50-line-diff fork of the rig-execution file. Copying is a normal
  first step in a rewrite; the debt is that neither the old nor the new copy is marked as the one that will
  survive, so the next edit lands in one of them arbitrarily.

## Findings

1. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still place ready-made agent
   capabilities in `@slopus/happy-agent-features` and do not mention `happy-agent-modules`.
2. **The shipped prompts drift from captured vendor truth.** AGENTS.md is explicit that vendor descriptors
   and prompts are evidence and product code must conform to them — a rewrite does not license editing them.
   Measured against `packages/happy-providers`: Grok's `"You are Grok 4.5 released by xAI."` becomes
   `{{identity}}`; Codex's `"You are Codex, an agent based on GPT-5."` becomes `"{{identity}}, an agent based
on GPT-5."` and `"As Codex,"` becomes `"As {{name}},"`; the Claude prompts lose their `"You are Rig, a
coding agent powered by Claude Sonnet 5…"` opening and their entire `# Environment` section (sonnet: 2080
   words in vendor truth vs 2037 here; fable: 1242 vs 1137); Grok loses the provenance comment
   `// Captured from Grok CLI 0.2.111 for Grok 4.5.`. Separately, `claude_opus_5_system_prompt` has no
   counterpart in `happy-providers` at all — a prompt presented as vendor-shaped with no captured origin.
   Templating is the likely motive, but it has to be applied without altering or dropping vendor text.
3. **AGENTS.md content is delivered twice per turn** (`SystemPromptModule.instructions` plus
   `impl/agentsMdInstructions.ts:276-329`), doubling the cost of every large instruction file and giving the
   model two copies with different positional meaning.
4. **`AGENTS_MD_SPEC` is copied with a comment claiming otherwise.** `AgentsMd.ts` reproduces
   `packages/rig/sources/agent/prompt/agentsMdSpec.ts` verbatim while carrying the comment "Keep this text in
   the module rather than duplicating it across vendor prompts." Consolidating the spec in the module is the
   right call for the rewrite; the comment should describe the actual state, and the v1 copy needs an owner.
5. **A symlinked AGENTS.md aborts the turn.** `readBoundedDocument` (`impl/agentsMdInstructions.ts:445-520`)
   throws `AGENTS.md document must not be a symbolic link: ${path}` at line 464. That error propagates out of
   prompt assembly, so a symlinked AGENTS.md — a normal setup in monorepos and dotfile repos — does not
   degrade the prompt, it fails the whole turn.
6. **Dead literals in the provider-kind schema.** `systemPromptProviderKindSchema`
   (`SystemPromptSelection.ts`) accepts `"bedrock"` and `"gym"`, which no mapping ever consults. A
   Bedrock-hosted Claude model passes validation and silently falls through to `simple_system_prompt` — the
   check succeeds and the agent gets the wrong prompt.
7. **Dead code and a byte/character bug.** `fileExists` (`impl/agentsMdInstructions.ts:538-553`) is never
   called. `truncateUtf8` (`:637-652`) compares `text.length > maxBytes`, treating UTF-16 code units as
   bytes, so its "byte" bound is wrong for any non-ASCII AGENTS.md; and
   `truncateUtf8WithNotice`/`decodeUtf8Prefix` (`SystemPromptModule.ts:243-268`) walk down one byte at a time
   against a 1,000,000-byte ceiling.
8. **Rendering has side effects.** `instructions` (`impl/agentsMdInstructions.ts:252-265`) writes the KV
   fingerprint while producing the prompt, so asking what the prompt is mutates state. The same file also
   revalidates its own typed compute dependency (`hostComputeSchema`, `:192-202`) and every snapshot it built
   itself — the over-validation pattern seen across this package.

## What it gets right

The AGENTS.md semantics are the best-executed part of the rewrite and match v1's intent precisely:
nearest-file-wins precedence, root-to-cwd ordering, the global-file-loses-to-project rule, and re-delivery
as a superseding record when a file changes, with the explicit framing that a superseding record is not a
new request. Documents are read under a size bound rather than trusted, the security file is handled as a
distinct protected input, prompt selection degrades to a usable generic prompt instead of failing on an
unrecognized model, and `promptFor`'s placeholder handling (all `{{name}}`, first `{{identity}}`) is small
and predictable.
