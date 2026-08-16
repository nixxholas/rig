# System prompt

`SystemPromptModule` is the single instruction module for an agent. It selects the native prompt
for the model in force, substitutes the configured identity, appends truthful host environment
details, and supplies the global, security, and project `AGENTS.md` instruction chain.

```text
vendor/model prompt
        │
        ├── # Environment (when Agent Base carries one)
        │
        └── AGENTS.md specification
              ├── global AGENTS.md
              ├── project-root AGENTS_SECURITY.md
              └── project AGENTS.md files, Git root → working directory
```

```ts
const created = createComputeModules();
const computeResolver = {
    resolve: async (ctx, agentId) => await created.computeModule.resolve(ctx, agentId),
};
const systemPrompt = new SystemPromptModule({
    identity: { name: "Scout", prompt: "You are Scout, built by Happy" },
    availableModels: [{ name: "Claude Opus", id: "anthropic/opus-5", providerId: "anthropic" }],
    compute: computeResolver,
    globalInstructions: {
        path: "/user/config/AGENTS.md",
        read: async (ctx, path, maxBytes) => await readBounded(ctx, path, maxBytes),
    },
});
```

All options are optional. Without an identity the module uses
`DEFAULT_SYSTEM_PROMPT_IDENTITY`; without compute or a global reader it still supplies the
AGENTS.md semantics specification. Constructor options are closed TypeBox contracts. Identity and
model-catalog values are cloned and frozen, while the injected compute resolver and reader remain
host-owned services.

The identity name must be non-blank, at most 128 characters, and free of NULs, carriage returns,
line feeds, `{`, and `}`. The identity prompt must be non-blank, at most 4,096 characters, free
of NULs, and must not contain `{{identity}}` or `{{name}}` markers. Invalid outer options,
identity values, model catalogs, and catalog byte totals have distinct stable constructor errors:
`"System prompt module options are invalid."`, `"System prompt identity is invalid."`,
`"System prompt available models are invalid."`, and
`"System prompt available models exceed the configured UTF-8 byte bound."`, respectively.

## Prompt selection and assembly

`promptFor(selection)` synchronously selects and renders the vendor prompt:

1. An exact model entry wins.
2. Otherwise a recognized model prefix (`anthropic/`, `openai/`, or `xai/`) selects its family.
3. Otherwise `providerKind` selects the Claude, Codex, or Grok family.
4. Everything else receives the simple fallback prompt.

The prompt sources live under `prompts/`; `impl/systemPromptForModel.ts` owns selection and
`impl/trimIndent.ts` keeps template indentation out of model-facing text. Identity replacement is
literal, so replacement-string metacharacters are not interpreted. `promptFor` replaces every
`{{name}}` marker with the trimmed identity name, but only the first `{{identity}}` marker with
the trimmed identity prompt, matching the legacy substitution order.

`instructions(ctx, scope)` is asynchronous because AGENTS.md files are discovered live. Its exact
order is the selected vendor prompt, the optional environment section, then the AGENTS.md
specification and documents. The environment contains working directory, platform, shell, OS
version, scratch-directory guidance, final-message visibility, workspace/worktree guidance, and
the bounded host-supplied model catalog. The catalog accepts at most 1,000 routes, each with a
non-empty name, model ID, and provider ID of at most 256 characters; its rendered UTF-8 section
is capped at 512,000 bytes at construction.

The complete UTF-8 output is capped by `MAX_SYSTEM_PROMPT_OUTPUT_BYTES`. Available-model fields,
item count, and rendered UTF-8 bytes have their own constructor bounds. AGENTS.md discovery caps
each document, total bytes, document count, paths, and rendered characters. Oversized instruction
documents become explicit bounded truncation records, and the final AGENTS.md instruction chain
is truncated again at assembly when its UTF-8 bytes would exceed the remaining system-prompt
budget. This keeps the live instruction chain from turning an otherwise valid turn into a
permanent output-bound failure.

## AGENTS.md discovery and changes

The injected compute resolver selects the current agent's compute, so one shared module instance
can safely serve agents in different workspaces. Discovery reads from the nearest Git root down to
the compute working directory. It refuses symbolic links at instruction document paths and reads
through the compute filesystem with the current permission context. `readAgentsMd(ctx, agentId)`
exposes the same validated snapshot to host callers.

The optional global reader is called on every inference. It owns how the host's global
`AGENTS.md` path is read; this module owns the requested byte bound and validates the result. A
reader may return at most `maxBytes + 1` characters, where the extra character is only a
truncation sentinel. Larger host results are rejected before encoding, and the module encodes
only a bounded prefix.

`readAgentsMd` accepts agent IDs up to `MAX_AGENTS_MD_AGENT_ID_LENGTH`, rejects blank IDs and
control-line characters, and validates the ID before calling either injected host service.

After first delivery, the module stores the last instruction fingerprint in its per-agent module
KV. If a document changes or disappears, `beforeTurn` also persists a pending transition with a
random notice ID, then emits one hidden durable steering notice. The ID remains stable while that
transition retries but changes when the same content or removal recurs later, so Agent Base's
permanent message-ID deduplication cannot suppress a later cycle.
`messageAcceptedTransact` advances the fingerprint and clears the pending transition only when
Agent Base durably accepts that exact hidden notice. `beforeTurn` also stores the validated
instruction snapshot in `runKV`; every inference in that turn uses that same snapshot. A file edit
after the turn boundary is therefore delivered coherently on the following turn rather than
mixing one notice version with another system-prompt version.

## Tools, storage, and concurrency

The module exposes no tools and owns no database or filesystem. Its durable Agent Base KV state is
the per-agent fingerprint plus any pending change notice. Immutable constructor configuration is
safe to share; live per-agent values are resolved from `ctx`, `scope`, KV, and the injected compute
on every call.

Public operations are:

- `promptFor(selection)` — render a vendor prompt with identity substitution.
- `instructions(ctx, scope)` — assemble the complete system prompt.
- `readAgentsMd(ctx, agentId)` — return the current validated instruction snapshot.
- `systemPromptForModel(selection)` — select the raw prompt template without constructing the
  module.
