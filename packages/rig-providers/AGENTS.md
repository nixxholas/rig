# Requirements

This package is the low-level technical integration with every model vendor. Its purpose is to
reproduce each vendor's real network behavior for inference exactly, and to expose that behavior
above a small shared interface. Everything else in Rig — the agent loop, tool execution,
permissions, conversation persistence — lives outside this package.

The goal is a network layer that is maximally reliable and predictable, and that always sends
exactly what it should. This is where the largest share of errors and problems occur, and they are
extremely difficult to debug: a wrong header, a reordered message, or a broken cache prefix
produces no exception and no stack trace, only degraded output somewhere far away. Correctness
here cannot be recovered downstream. Make no mistakes.

Read [README.md](README.md) for the external protocol, types, and lifecycle before changing
anything here. These requirements bind every file in this directory tree.

## What this package owns

- **The network.** Connection establishment, transports, keep-alive, headers, request framing,
  and stream decoding.
- **Sessions.** Providers are stateful. A session is created, used for many turns, and destroyed.
  Connection reuse, prompt caching, sticky turn state, and compaction are session-owned.
- **Retries.** Retry logic belongs to the provider, never to outer code. Each vendor retries
  differently, and the difference is the point. This overrides the repository default whenever a
  native provider retries after output has begun: the provider must expose and test a rollback
  boundary so replay cannot duplicate visible output or tool effects.
- **Error parsing.** Every error must be parsed into typed, meaningful terms. A raw upstream
  diagnostic string is never an acceptable outcome.
- **Credentials.** The caller decides which credential a provider uses. It may pass a token
  directly, ask a credential class to load one from the native client's on-disk location, or run
  discovery across everything available on the machine. This package supplies all three paths and
  keeps tokens refreshed; it never decides policy about which account to use.

## Fidelity is the product

The goal is that our request looks exactly like the native client's request. Ordered by how much
each one matters:

1. **Prompt caching.** The single most important property. Context must not be shuffled
   non-deterministically, and cache-relevant prefixes must stay byte-stable across turns.
2. **System prompts.** Must match exactly.
3. **Tool definitions.** Must match exactly.
4. **Message ordering.** Must match exactly.

Small technical incidentals in a request are not worth chasing. The four properties above are.

Never invent tools, never inject Rig's own tools or system prompts into a vendor request, and
never change how the real client behaves. If the native client does something surprising,
reproduce the surprise.

### What "must match" means at runtime

This package never chooses the content of a prompt or a tool. The caller supplies both, and its
definitions differ from the vendor's on purpose. So the rules above apply to two different things
depending on when they are being judged:

- **At runtime**, what must match is the _envelope and mechanics_: field names and nesting, message
  ordering, tool serialization shape, cache-control placement and prefix stability, headers, and
  framing. Given the caller's content, the request must be byte-identical to what the native client
  would have produced carrying that same content.
- **In reproduction tests**, prompt and tool _content_ must match too, because the test supplies the
  vendor's own definitions from `prompts/` and `tools/` and compares against a real capture.

A caller shipping its own system prompt is correct and expected. This package serializing that
prompt into a differently shaped request is a bug.

A provider may be stripped back to the barebones, but it must always be reconstructable into
something that matches the native implementation.

### Headers and identification

Specifying every header precisely is not realistic, and trying to enumerate them would go stale
faster than it helps. The default is simply to behave the way the native client behaves: send the
user agent and client identification headers it sends, in the form it sends them.

Identification should nonetheless remain **overridable**. Rig is not trying to disguise itself, and
a vendor may reasonably prefer that traffic from Rig be identifiable as Rig. Each provider should
therefore accept a `userAgent` provider option, defaulting to the native value. Every vendor
supports this. How it reaches the wire differs: Codex and Grok set the header directly, Bedrock
sets a default header on the SDK client, and Claude uses `ANTHROPIC_CUSTOM_HEADERS`, which Claude
Code applies over its own defaults.

Treat headers that carry protocol meaning — content type and encoding, session and turn identity,
protocol version, feature flags such as the Responses Lite header — as part of the request that
must match. Purely cosmetic differences are the incidentals that are not worth chasing.

## Golden traces

Development in this package is trace-driven.

**Capturing.** Traces are captured by running the real vendor binaries behind an HTTP proxy and
recording exactly what goes to the server and what comes back. Capture scripts already exist for
every client under `tests/vendors/capture*.mjs` — always use them, never write new ones. A capture
uses a fixed workspace with fixed content and fixed prompts, an isolated home directory, and no
Rig tools, no Rig system prompts, and no customization of any kind. The recorded traffic must be
completely original vendor behavior. Prefer a sandboxed capture so the client under test cannot
reach anything it does not need.

**Reproducing.** A golden trace is a **black box**. Do not read values out of a trace and replay
them. Reproduce them:

- System prompts are written directly in TypeScript under each vendor's `prompts/` directory.
  They are literal string constants, not JSON pulled from a fixture.
- Tools are written as `SessionTool` values under each vendor's `tools/` directory, with
  parameters typed using TypeBox only. Never an untyped JSON object, never `as unknown`.
- Skills are defined the same way, in source.

The test then configures the transport and asserts that the resulting request matches the
captured one. Everything must line up.

**Running.** These tests reach the real backends and use the credentials already present on the
system or in the global Rig configuration. They are on-demand only and must never run in the
ordinary suite. Live tests are gated behind `RIG_LIVE_TEST=1` and named `*.live.test.ts`.

## Reference sources

The native clients' own source trees are checked out at `~/Developer/coding-assistant-sources`:

```
~/Developer/coding-assistant-sources/
    codex/          https://github.com/openai/codex
    claude-code/
    grok-build/     https://github.com/xai-org/grok-build
    pi/             https://github.com/earendil-works/pi
```

These are the authority for behavior a short trace cannot exercise: state transitions, retry
schedules, fallback rules, and the exact prompt text a capture may not have triggered.

**Keep them fresh.** Before relying on one, go into the directory and pull the latest from GitHub,
then read the current prompts, tools, and transport code rather than trusting whatever was checked
out months ago. Vendors revise prompts and protocols continuously.

There is no strict version policy and no requirement to re-capture traces on every upstream change.
Aim to track a recent harness rather than a pinned one. When upstream source and a golden trace
disagree, the trace is the authority for the wire shape actually sent, and the source explains why
— record the difference rather than silently conforming to one of them.

## Recorded responses

Golden traces prove the happy path, but they are expensive to collect and cannot be re-captured on
demand for every failure. An out-of-tokens response, a rate limit, an overloaded backend, or an
expired credential cannot be reproduced against a live server whenever a test needs one.

So when a real response is worth parsing, **record it once and keep it**. Save the status line,
the headers, and the body, then write a deterministic test that replays it. Over time this becomes
a growing collection of real vendor failures, and every parser is checked against traffic the
vendor actually sent rather than a string someone imagined.

Record the real response whenever one is seen — a failure observed once in development is worth
saving even if the parser already handles it. These tests are deterministic, need no credentials,
and run in the ordinary suite.

**Redact before committing.** Editing a trace to remove secrets is expected and correct; it is not
a violation of treating traces as originals. Strip bearer tokens, API keys, cookies, account and
organization identifiers, and anything else user-identifying. Keep whatever the parser actually
reads — status, error codes and types, retry and reset headers, quota fields, request IDs when they
are diagnostic rather than identifying — and keep the structure intact, since the structure is the
thing under test. The golden capture scripts already normalize and redact this way; follow the same
approach.

Store recorded failures next to the golden fixtures under `tests/vendors/fixtures/`, named for the
vendor and the failure, such as `codex-rate-limit-429.json` or `claude-out-of-tokens-429.json`.
Record the status, the headers, and the body verbatim after redaction.

Replay through the transport, not around it. A test that calls a classifier with a hand-written
message proves only that a string matcher works; it does not prove that the status, headers, and
body actually reach the classifier. Use whichever seam a vendor already provides:

- point `endpoint` at a local HTTP server for Codex, Grok, and Bedrock;
- inject `client` for Bedrock when the failure is below the HTTP layer;
- set `ANTHROPIC_BASE_URL`, as the capture scripts do, for the Claude Code SDK transport.

A custom `fetch` is equally acceptable where a provider takes one. What matters is that the bytes
enter through the real code path and the assertion is made on the parsed `SessionProviderError`,
the resulting `done` event, and the retry behavior the response should produce.

### The error taxonomy

A vendor may extend the shared error vocabulary with cases only it can produce. An extension is
still an extension: anything a vendor cannot confidently identify falls back to `unclassified`,
which carries a specific meaning — **we do not know how to recover from this**.

That meaning follows from where retries live. Everything retryable is already retried inside the
provider, so by the time an error surfaces to the caller it has either exhausted its retries or was
never retryable to begin with. A surfaced error is therefore terminal by definition: the caller
does not decide whether to retry it, it displays it. Every error that reaches the caller must
consequently carry a message fit to show a person.

An error worth distinguishing is one the caller would act on differently — exhausted tokens, a rate
limit with a reset time, expired credentials, a context overflow. Adding a case that no caller
treats differently only adds vocabulary. When a recorded failure lands in `unclassified` and the
caller would have benefited from knowing what it was, that is the signal to add a case.

## Vendor layout

Everything belonging to a vendor lives under `sources/vendors/<vendor>/`, with a fixed shape:

```
sources/vendors/<vendor>/
    <Vendor>Provider.ts        entry point and options
    <Vendor>Session.ts         the stateful session
    <Vendor>*Credential.ts     credential loading
    prompts/                   literal system prompt text
    tools/                     SessionTool definitions
    skills/                    native skill definitions, internal only
    errors/                    error parsers and classifiers
    impl/                      transport, request building, stream decoding
```

`prompts/`, `tools/`, `skills/`, and `errors/` are the vendor's reproduced surface: the text, the
schemas, and the failure vocabulary. `impl/` is the machinery that carries them over the wire.
Keeping error parsing in its own directory matters because it grows with the recorded-response
collection — each new failure adds or refines a parser, and they should be findable as a set
rather than scattered among request builders.

### One file per connection

The low-level layer that abstracts a **single connection** belongs in a single file. For SSE or
HTTP that is simply a class that performs one request and exposes the vendor-specific internal
representation of the result. Keep the whole network path — connecting, framing, decoding, idle
handling — together in that file, and export only the internal representation.

Do not scatter this across the session's files. A session that absorbs its transport turns into a
huge object very quickly. The session should drive a connection, not contain one.

### Prefer fewer, larger files

This package **overrides** the repository's one-function-per-file convention. That convention was
applied here past the point of usefulness, leaving directories full of three- to sixteen-line
files that were harder to read than the thing they were meant to clarify.

Keep related network code together in one file rather than splitting every helper into its own.
A file should hold a coherent piece of behavior with its small helpers alongside it. Split when a
file genuinely covers separate concerns, not because a function could technically stand alone.
The reproduced surface — prompts, tools, skills, errors — is the exception: those stay granular,
because each entry is a distinct piece of vendor behavior a reader may want to find on its own.

Error parsing belongs in `errors/`, one file per vendor, never among the request builders.

## Transports

Every transport a vendor really uses must be supported. There are more of them than the protocol
names suggest, and near-identical protocols still differ in practice:

- **Codex** has several: the newer WebSocket protocol, the newer SSE protocol, and a Bedrock
  variation of the OpenAI shape.
- **Anthropic** has direct inference and Bedrock, each with its own nuances.
- **Claude** additionally has the distinct transport where we drive the Claude Code SDK.

Sharing code between transports is welcome when it is genuinely the same behavior. Usually it is
not. Do not force reuse at the cost of fidelity.

## One inference at a time, and `fork`

`run` is exclusive. A session never has two inferences in flight at once, and the implementation
may rely on that: a single connection, a single sticky turn state, and a single cache prefix are
all legitimate given this guarantee. Do not add internal queueing or locking to make concurrent
`run` calls appear to work.

Branching is done with `fork` instead. `fork` creates a new session that copies the whole internal
state of the original, including its identity — the forked session carries the **same** session ID,
because as far as the vendor is concerned it is a continuation of the same conversation, not a new
one. Two forks can then run inference independently.

Preserving the ID is the point: a fork inherits the parent's warm cache instead of paying for a
cold prefix. The motivating case is compaction ahead of the limit. Compaction runs on a fork while
the original session stays live and usable; when it finishes, the caller switches to the forked
session and appends the messages that were not part of the compacted prefix. Nothing has to be
paused, and no cache is thrown away. The same shape covers speculative or background work — running
something on a branch and keeping it only if it is wanted.

Forking must copy state, never share it. A fork that aliases the parent's connection, mutable
context, or turn state will corrupt both sides the moment either one runs. Whatever a vendor keeps
per session — connection, warmup state, cached prefix, response IDs, credentials — must be
duplicated or re-established so neither session can observe the other's turns.

## The external interface

The interface above these providers is deliberately simplified, but it cannot be simplified so far
that vendor-specific behavior becomes unreachable. Vendor-specific options must remain
expressible, and they belong on the vendor's own options type rather than in the shared surface.

Codex is the clearest example. `parallelToolCalls` selects standard Responses instead of Responses
Lite, because multi-call batches are unavailable under Lite. Where a vendor protocol depends on
code-mode execution, we do not adopt it: the rewrite it would force is large and the benefit is
unproven. Decisions like this are deliberate omissions, not gaps to be closed later, and should be
recorded in the vendor document rather than silently reversed.

## Compaction

- Always use native compaction where the vendor provides it. Never implement compaction here.
- No automatic compaction inside this package. Outer code decides when to compact.

## Prompts, tools, and skills are internal

None of the reproduced vendor assets are part of the external API. `prompts/`, `tools/`, and
`skills/` are **not exported**. Nothing in `sources/index.ts` may re-export them, and no code
outside this package may import them.

They exist for two reasons: so tests can reproduce real requests, and so a person can read how the
native client actually behaves. That second reason is worth as much as the first — these files are
documentation of real vendor behavior in a form that can be verified against a trace. Keep them
structured and faithful to the vendor's own rendering, because their value is that a reader can
trust them.

The caller defines its own prompts and tools, outside this package, and composes them into
`instructions` and `tools` on the session. The definitions here are the vendor's originals and are
kept for comparison, not for reuse. Callers routinely need slightly different tools, so trying to
share one definition between the reference copy and the production copy is unrealistic — the two
would drift into a merged shape that matches neither. Keep them separate and let tests prove the
difference is intentional. `rig-execution` already works this way, keeping its own copy of the
Grok system prompt rather than importing one.

Skills follow the same rule and are additionally not a session concept: the session interface must
not take a `skills` option.

Trace fidelity is unaffected by any of this. Requests must still be reproduced exactly and covered
by golden-trace tests, including vendor-native skill headers, location formats, ordering, and
closing text.

Not yet done. `sources/index.ts` still re-exports the Codex prompts, tools, and skills and the Grok
prompt and tools, and `skills` still exists as a session option on `SessionOptions`,
`SessionModelConfiguration`, and all four vendor session types. The exports and the option go; the
directories stay. No consumer outside this package imports them today, so removal is unblocked.
