# Module report: systemPrompt

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/systemPrompt/` (README,
`SystemPromptModule.ts`, `SystemPromptSelection.ts`, `AgentsMd.ts`, `impl/`, `prompts/`) compared against
vendor truth in `packages/happy-providers/sources/vendors/*/prompts/`, `packages/rig-execution/sources/prompts/`,
and Rig's own `packages/rig/sources/agent/prompt/` and `agent/impl/reconcileAgentsMdMessages.ts`; plus root
`AGENTS.md` and master plans 00, 07, 16, 20, 21.

## Summary

The module picks a system prompt per model, fills two placeholders, and appends AGENTS.md content. The
selection layer is small; the problem is everything under it. The `prompts/` tree is a near-verbatim third
copy of vendor prompts that have already drifted from vendor truth, `AGENTS_MD_SPEC` is a verbatim
duplicate of Rig's spec text (carrying a comment about avoiding duplication), the AGENTS.md discovery is a
reimplementation of Rig's, and the module then delivers the discovered documents *twice* — once in the
system prompt and once as a hidden steering message — where Rig deliberately delivers them exactly once and
not in the prompt.

## How it differs from Rig's equivalents

- **One assembled prompt vs. a table of forks.** Rig's `agent/prompt/createSystemPrompt.ts` assembles a
  single prompt from `AgentContext` — spec, skills, plugins, available models, collaboration, workspaces,
  docs, generated media, tool instructions, permissions, protected paths, secrets, `appendSystemPrompt`.
  This module keeps whole prompt files per model and selects one
  (`impl/systemPromptForModel.ts`: `promptsByModel` for four Anthropic ids, `promptsByVendor` for
  claude/codex/grok, `vendorsByModelPrefix` for `anthropic/`/`openai/`/`xai/`, else `simple_system_prompt`).
- **AGENTS.md placement.** Rig keeps AGENTS.md documents out of the system prompt on purpose; the inline
  comment in `createSystemPrompt.ts` says system messages are positional notices delivered in the
  conversation and folding one into the prompt "would move it away from the turn it belongs to and rewrite
  the cached prefix on every notice." Rig delivers them as conversation records via
  `agent/impl/reconcileAgentsMdMessages.ts` + `loadAgentsMdInstructions.ts`. This module puts them in the
  prompt (`SystemPromptModule.instructions`) **and** emits a hidden steering user message containing the
  entire body (`impl/agentsMdInstructions.ts:276-329`, `${REPLACEMENT_NOTICE}\n\n${loaded.body}`) — the same
  text sent twice, and the cached prefix rewritten whenever a file changes.
- **Discovery.** `relevantDirectories` (`impl/agentsMdInstructions.ts:418-443`) reimplements Rig's
  `findAgentsMdPaths.ts` / ancestor-walk / project-root logic. It also diverges on the security file: Rig
  reads `AGENTS_SECURITY.md` from `fs.cwd`, this module reads it from the git root
  (`impl/agentsMdInstructions.ts:206-211`), so the two disagree about which security rules are in force.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities in
   `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules` at all.
2. **A third copy of the vendor prompts, forked from a fork.** Three prompt trees now exist:
   `packages/happy-providers/sources/vendors/{claude,codex,grok}/prompts/` (vendor truth),
   `packages/rig-execution/sources/prompts/{claude,codex,grok}/`, and this module's
   `sources/systemPrompt/prompts/{claude,codex,grok,simple}/`. Module-vs-rig-execution diffs are trivial —
   `claude_opus_5_system_prompt` 4 lines, `claude_sonnet_5_system_prompt` 4, `grok_4_5_system_prompt` 4,
   `codex_agent_instructions` 8 lines and import-path only — i.e. this is a copy of a copy. `impl/trimIndent.ts`
   is byte-identical to `packages/rig-execution/sources/prompts/trimIndent.ts`, and
   `impl/assembleEnvironmentPrompt.ts` is a 50-line-diff fork of the rig-execution file.
3. **The copies drift from vendor truth.** AGENTS.md says vendor descriptors and prompts are evidence and
   product code must conform to them. Measured against `happy-providers`: Grok's
   `"You are Grok 4.5 released by xAI."` becomes `{{identity}}`; Codex's `"You are Codex, an agent based on
   GPT-5."` becomes `"{{identity}}, an agent based on GPT-5."` and `"As Codex,"` becomes `"As {{name}},"`;
   the Claude prompts lose their `"You are Rig, a coding agent powered by Claude Sonnet 5…"` opening and
   their entire `# Environment` section (sonnet: 2080 words in vendor truth vs 2037 here; fable: 1242 vs
   1137); Grok loses the provenance comment `// Captured from Grok CLI 0.2.111 for Grok 4.5.`. Separately,
   `claude_opus_5_system_prompt` has no counterpart in `happy-providers` at all — a prompt presented as
   vendor-shaped with no captured origin.
4. **`AGENTS_MD_SPEC` is the duplicate it warns about.** `AgentsMd.ts` reproduces
   `packages/rig/sources/agent/prompt/agentsMdSpec.ts` verbatim while carrying the comment "Keep this text
   in the module rather than duplicating it across vendor prompts." The text is now in two packages and will
   diverge on the next edit to either.
5. **A symlinked AGENTS.md aborts the turn.** `readBoundedDocument`
   (`impl/agentsMdInstructions.ts:445-520`) throws `AGENTS.md document must not be a symbolic link: ${path}`
   at line 464. That error propagates out of prompt assembly, so a symlinked AGENTS.md — a normal setup in
   monorepos and dotfile repos — does not degrade the prompt, it fails the whole turn.
6. **Dead literals in the provider-kind schema.** `systemPromptProviderKindSchema`
   (`SystemPromptSelection.ts`) accepts `"bedrock"` and `"gym"`, which no mapping ever consults. A Bedrock-hosted
   Claude model silently falls through to `simple_system_prompt` — the validation passes and the agent gets
   the wrong prompt, which is the worst of both outcomes.
7. **Dead code and a byte/character bug.** `fileExists` (`impl/agentsMdInstructions.ts:538-553`) is never
   called. `truncateUtf8` (`:637-652`) compares `text.length > maxBytes`, treating UTF-16 code units as
   bytes, so its "byte" bound is wrong for any non-ASCII AGENTS.md; and
   `truncateUtf8WithNotice`/`decodeUtf8Prefix` (`SystemPromptModule.ts:243-268`) walk down one byte at a time
   against a 1,000,000-byte ceiling.
8. **Rendering has side effects.** `instructions` (`impl/agentsMdInstructions.ts:252-265`) writes the KV
   fingerprint while producing the prompt, so asking what the prompt is mutates state. The same file also
   revalidates its own typed compute dependency (`hostComputeSchema`, `:192-202`) and every snapshot it
   built itself — the over-validation pattern seen across this package.

## What it gets right

The AGENTS.md semantics are correct and carefully implemented: nearest-file-wins precedence, root-to-cwd
ordering, the global-file-loses-to-project rule, and re-delivery as a superseding record when a file
changes, with the explicit framing that a superseding record is not a new request. Documents are read under
a size bound rather than trusted, the security file is handled as a distinct protected input, and prompt
selection degrades to a usable generic prompt instead of failing when a model is unrecognized. `promptFor`'s
placeholder handling (all `{{name}}`, first `{{identity}}`) is small and predictable.
