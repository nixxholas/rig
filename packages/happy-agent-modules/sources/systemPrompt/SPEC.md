# System prompt — the instructions every model runs on

This document specifies `SystemPromptModule` (`sources/systemPrompt/`): the one module that decides
what an agent is told before anything else is said to it. It selects the prompt the model in force
was written for, substitutes the host's identity, states the machine the agent is working on, and
delivers the project's own `AGENTS.md` instructions — including keeping them current while a
conversation is open.

## 1. What the module is for

Every model is trained differently and is told how to behave in its own words. So the prompt an
agent runs on follows **the model**, not the agent: the module reads the model from the scope Agent
Base hands it, which means an agent that switches models mid-conversation gets the new model's
prompt on the very next inference with nothing else changing. A model nobody has written a prompt
for gets the simple one, so there is always a prompt and never a silent absence of one.

The module owns no database, no filesystem, no tools, and no lock. Its only durable state is two
keys in the agent's own module KV. Everything else is either immutable constructor data or read
live from the agent's compute.

## 2. Composition

`instructions(ctx, scope)` returns exactly these sections, in this order, joined by blank lines:

```text
vendor/model prompt          ← always
# Environment                ← when Agent Base carries an environment
AGENTS.md specification      ← always
  global AGENTS.md           ← when a host reader supplies one
  AGENTS_SECURITY.md         ← project root only
  AGENTS.md documents        ← Git root → working directory
```

The AGENTS.md specification text is present even when no instruction file exists anywhere, because
it explains a convention the model must follow whether or not a file is delivered with it.

## 3. Prompt selection

`systemPromptForModel(selection)` — also exported standalone, so selection can be inspected without
constructing the module — resolves in this order:

1. **An exact model entry.** `anthropic/opus-5`, `anthropic/sonnet-5`, `anthropic/fable-5`, and
   `anthropic/opus-4-8` each have their own prompt.
2. **A model-ID prefix.** `anthropic/` → Claude, `openai/` → Codex, `xai/` → Grok. The family
   default is the Opus 5 prompt for Claude, the Codex agent instructions for Codex, and the Grok
   4.5 prompt for Grok.
3. **`providerKind`,** but only `claude`, `codex`, or `grok`.
4. **The simple prompt** for everything else.

The model ID is consulted before the provider because **the ID names the vendor even when the
provider does not**: a Claude model served through Bedrock is still a Claude model. This is why
`providerKind` accepts `bedrock` and `gym` but neither selects a family — a Bedrock agent is
identified by the model it is running, and a `providerKind` that names no vendor falls through to
the simple prompt rather than guessing one.

Selection is synchronous and pure. `promptFor(selection)` is the same selection plus identity
substitution and the output bound.

## 4. Identity

The host supplies `{name, prompt}`; without one the module uses `{name: "Rig", prompt: "You are
Rig, built by Happy"}`. Substitution into the selected prompt is:

- **every** `{{name}}` marker replaced with the trimmed name;
- **only the first** `{{identity}}` marker replaced with the trimmed prompt.

Both replacements pass a function to `replace`, so `$&`, `$1`, and other replacement-string
metacharacters in a host-supplied identity are inserted literally rather than interpreted.

The identity schema is what keeps substitution honest. A name may not contain NUL, CR, LF, `{`, or
`}`; a prompt may not contain NUL and may not itself contain `{{identity}}` or `{{name}}`. A host
therefore cannot leave an unresolved template behind, inject a second marker, or use its identity
to change the module's composition rules. Both fields must be non-blank.

## 5. The environment section

Rendered only when Agent Base carries an environment, and validated against
`agentEnvironmentSchema` before use. It states the primary working directory, platform, shell (the
line is omitted entirely when the shell is blank), OS version, and the current model — the display
name from the catalog when the model ID matches a route, and always the model ID itself, but never
the effort or speed; the line is omitted when the agent has not selected a model yet — then the
standing host guidance
that belongs with them: the `.context/` scratch directory and its gitignore expectation, the fact
that the user sees only the last message before the agent stops, and that a workspace and a Git
worktree are the same thing.

The host's model catalog is appended here as `## Available models`, printing only a name, model ID,
and provider ID per route. Capability details stay outside this module — the prompt needs only what
it prints.

## 6. AGENTS.md discovery

Discovery runs against the **current agent's** compute, resolved through the injected
`ComputeResolver` on every call, so one shared module instance serves agents in different
workspaces correctly.

**Which directories.** Walk from the compute's working directory up through every ancestor,
stopping at the first ancestor that contains a `.git` entry; that ancestor is the project root, and
the directories from it down to the working directory are read in root-to-leaf order. When no
ancestor has a `.git`, the working directory alone is read — the walk does not escape into the
filesystem looking for a project that is not there. A compute that cannot read a parent boundary
simply contributes nothing to the search rather than failing it.

**What is read.**

- `AGENTS_SECURITY.md`, from the project root only, bounded to 32 KiB.
- `AGENTS.md` in each directory: at most 32 documents, each at most 64 KiB, at most 256 KiB in
  total. The per-document bound is narrowed to whatever remains of the total as the walk proceeds.
- The global `AGENTS.md`, through the injected host reader, bounded to 256 KiB.

**Reading rules.** A document path is `lstat`ed first. A **symbolic link at a document path is an
error**, not a skip: following one would let a project instruction escape the compute's intended
filesystem boundary. A missing path, a non-file, and an empty or whitespace-only file each
contribute nothing. A file larger than its bound becomes an explicit record saying its contents
were omitted, so the model learns the file exists rather than silently not seeing it. A file that
grows between the stat and the read is re-stated once and preserved the same way; every other read
failure, permissions included, stays visible.

**The global reader.** The module owns the path and the byte bound; the host owns how that path is
read. A reader may return at most `maxBytes + 1` characters — the extra character exists only so a
host can signal truncation — and a longer result is rejected before encoding. The reader is called
on **every** instruction hook, so an edit to the global file reaches the next inference without
restarting the agent.

Nothing is cached across calls. Within one turn, §8 pins a single snapshot.

## 7. Formatting

Documents are rendered under a heading naming their directory and wrapped in a tag: `<INSTRUCTIONS>`
for the global and project files, `<SECURITY_RULES>` for `AGENTS_SECURITY.md`. Order is global,
then security, then project files root-to-leaf — the order the specification tells the model to
resolve conflicts in, with the most local file last.

A truncated document carries its own marker inside its tag; a snapshot that lost anything at all
appends a chain-level truncation notice. The whole chain is fitted to 300,000 characters, the
specification text is reserved out of that budget first, and a section that does not fit is cut
with the truncation notice appended rather than dropped whole.

## 8. Keeping instructions current

This is the subtle part of the module, and the reason it implements two hooks it would otherwise
not need.

**The fingerprint.** The SHA-256 of the formatted body — the documents, not the specification text
— is stored in module KV under `last-delivered-fingerprint`. An empty body fingerprints as `null`,
which is how "there are no instructions" is distinguished from "they have not been read yet". The
`instructions` hook seeds the key on first delivery, which is precisely why the first turn of a
conversation never announces anything.

**Detecting a change.** `beforeTurn` reads the stored fingerprint and the current files. Unchanged,
or not yet seeded, means nothing happens. Changed means one durable steering action carrying either
the replacement notice followed by the new body, or the removal notice when the instructions are
gone. The notice is marked `hideFromUser`, because it is bookkeeping between the runtime and the
model rather than something a person said.

**Why the notice has an identity.** The pending transition `{from, id, to}` is persisted before the
steering action is returned. A retry of the same transition reuses the same ID, so Agent Base's
message-ID deduplication collapses the duplicate. But **a new ID is minted whenever the transition
itself is new** — including when the same content, or the same removal, recurs later. Without that,
Agent Base's permanent deduplication would silently swallow the second announcement of a file that
was reverted and changed again.

**Committing only what was delivered.** `messageAcceptedTransact` advances the fingerprint only
when Agent Base durably accepted _that exact notice_, and it checks all of it: the message is
steering, its ID is the pending notice's ID, it is hidden, it is a single user text part, the text
matches the removal notice exactly or begins with the replacement prefix and hashes to the
fingerprint being claimed, the pending record still names this transition, and the currently
delivered fingerprint is still the one the transition started from. Anything less leaves the old
fingerprint in place and the notice to be retried. A failed or interrupted enqueue therefore loses
nothing.

**One version per turn.** `beforeTurn` also writes the validated snapshot into `runKV`, and
`instructions` prefers it. Every inference in a turn is built from the same files, so a file edited
mid-turn is delivered coherently on the following turn instead of pairing one turn's notice with a
different turn's system prompt.

## 9. Bounds

Every bound exists so that live, host-controlled, or filesystem-controlled content cannot turn a
valid turn into a permanent failure.

| Bound                              | Value         |
| ---------------------------------- | ------------- |
| Whole system prompt output         | 1,000,000 B   |
| Available-models section, rendered | 512,000 B     |
| Available-models routes            | 1,000         |
| Available-model field length       | 256 chars     |
| Identity name                      | 128 chars     |
| Identity prompt                    | 4,096 chars   |
| Model ID in a selection            | 256 chars     |
| AGENTS.md chain, rendered          | 300,000 chars |
| One AGENTS.md document             | 64 KiB        |
| All AGENTS.md documents            | 256 KiB       |
| AGENTS.md document count           | 32            |
| `AGENTS_SECURITY.md`               | 32 KiB        |
| Global `AGENTS.md`                 | 256 KiB       |
| Path length                        | 4,096 chars   |
| Agent ID                           | 256 chars     |

The catalog bound is enforced at **construction**, where a bad value is a startup error rather than
a per-turn one. The instruction chain is bounded twice: once at 300,000 characters while formatting,
and again at assembly, where it is fitted into whatever the 1,000,000-byte output budget has left
after the vendor prompt and environment. Both truncations are announced in the text. UTF-8 prefixes
are cut on a code-point boundary, never mid-character.

Invalid construction inputs have four distinct, stable messages: `"System prompt module options are
invalid."`, `"System prompt identity is invalid."`, `"System prompt available models are
invalid."`, and `"System prompt available models exceed the configured UTF-8 byte bound."`

## 10. Public surface

- `instructions(ctx, scope)` — the assembled system prompt. An Agent Base hook.
- `beforeTurn(ctx, scope)` — the change notice and the per-turn snapshot. An Agent Base hook.
- `messageAcceptedTransact(ctx, scope, accepted)` — commits the fingerprint. An Agent Base hook.
- `promptFor(selection)` — the rendered vendor prompt alone, synchronous.
- `readAgentsMd(ctx, agentId)` — the current validated snapshot, for host callers.
- `readAgentsMdInstructions(ctx, agentId)` — the same content formatted as the instruction text
  models receive. The automatic permission reviewer appends this to its policy so a review sees the
  project's own intent, reread every time. It deliberately touches **no** delivery state: a review
  must not consume or advance a turn's fingerprint.
- `systemPromptForModel(selection)` — selection without constructing the module.

There are no tools. The module never becomes part of the model's action surface.

## 11. Invariants to preserve

- There is always a prompt. An unknown model gets the simple one; selection never returns nothing.
- The model ID decides the family before the provider does, so a vendor's model served through
  someone else's infrastructure still gets its own prompt.
- A host identity can never leave an unresolved marker, introduce a new one, or be interpreted as a
  replacement pattern.
- The AGENTS.md specification is delivered even when no AGENTS.md exists.
- Instruction files are read live, never cached across turns — but pinned within a turn, so one
  turn never mixes two versions.
- A symbolic link at an instruction path is an error. Discovery never follows one out of the
  compute's boundary.
- Oversized or numerous instruction content degrades into an announced, bounded record. It never
  fails the turn, and it never disappears silently.
- The delivered fingerprint advances only when Agent Base durably accepted the exact notice that
  carried that content.
- A repeated instruction transition gets a fresh notice ID, so message deduplication cannot
  suppress a later announcement of the same content.
- Reading instructions for someone else — the permission reviewer — must not disturb delivery
  state.
