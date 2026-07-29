# Provider-Owned Compaction and Steering

## Overview

Rig will compact long turns at the safe boundary after every tool call in the
current provider batch has a result and before the next inference. The provider
receives the complete closed context and returns the complete replacement
context; the agent no longer chooses a prefix and tail around a locally-built
summary.

Incomplete function and custom tool calls will never remain open. If inference
ends at the output limit while a tool call is partial, Rig records a linked
non-executed error result and does not invoke the tool.

Steering accepted during inference or tool work will be applied exactly once at
the earliest legal boundary. For a provider tool batch, Rig closes the entire
batch first, then inserts steering before the immediately following inference.

## Context

- Agent loop: `packages/rig/sources/agent/loop.ts`
- Agent compaction: `packages/rig/sources/agent/compaction/`
- Provider adaptation: `packages/rig-execution/`
- Provider contexts and Responses stream mapping: `packages/rig-providers/`
- Durable session and steering submission: `packages/rig/sources/server/InMemorySession.ts`
- End-to-end regressions: `packages/gym-tests/tests/`

The Work3 incident left an incomplete Responses custom tool call without an
output, causing both native compaction and the next inference to fail. Existing
agent compaction also discards the provider-returned replacement context, while
steering appears able to wait behind further tool iterations.

## Development Approach

- Reproduce each observable failure before changing production behavior.
- Preserve append-only visible transcript history while replacing only the
  provider/model context.
- Keep inference and compaction serialized and provider-neutral.
- Make every provider-emitted tool call reach exactly one terminal result.
- Update this plan immediately as tasks complete or scope changes.

## Implementation Steps

### Task 1: Regression tests

- [x] Add a deterministic gym regression for compaction inside one tool-heavy user turn.
- [x] Add deterministic coverage for incomplete function and custom tool calls.
- [x] Add a gym regression proving steering follows the nearest closed tool batch.
- [x] Cover steerable tools, ordered multiple steering, and parallel tool batches.
- [x] Run targeted tests and confirm the old behavior fails for the intended reason.

### Task 2: Provider-owned replacement context

- [x] Remove `preserveLatestUserMessage`, `findRetainedStart`, and local retained-tail policy.
- [x] Pass the complete closed context into provider compaction.
- [x] Carry the provider's full completed compaction result through execution to Agent.
- [x] Adopt the returned replacement context atomically after success.
- [x] Preserve one durable append-only compaction message with its opaque provider checkpoint.
- [x] Test completed, failed, cancelled, repeated, and same-turn compaction.

### Task 3: Incomplete tool closure

- [x] Represent incomplete function/custom calls without treating partial arguments as executable.
- [x] Create linked non-executed error results before returning a length outcome.
- [x] Preserve provider call IDs and valid Responses call/output pairing.
- [x] Test next inference and compaction after incomplete calls.

### Task 4: Earliest-legal steering

- [x] Trace steering acceptance through daemon, Agent, loop, and tool execution.
- [x] Close every call in the current provider batch before steering.
- [x] Insert pending steering before the exact next inference.
- [x] Interrupt steerable tools with linked interrupted results.
- [x] Preserve exactly-once ordering for local and external steering.
- [x] Ensure hard abort wins without creating a duplicate continuation.

### Task 5: Verification

- [x] Run affected package unit tests and typechecks.
- [x] Run the three targeted gym regressions.
- [x] Run the broad relevant gym suite and full workspace tests/checks.
- [x] Verify removed local compaction policy has no remaining references.
- [x] Review race behavior and the complete diff.

### ➕ Task 6: Durable compaction history contract

- [x] Add failing regressions for one durable compaction message in transcript, context, and restart.
- [x] Store replaced message IDs, compaction kind, and provider-dependent assembly on that message.
- [x] Store exact provider-reported context size before compaction and an estimated size after it.
- [x] Replace the estimate with the exact input/cache size from the first following inference before its final message is committed.
- [x] Project the durable message through protocol and `rig-connect` without a duplicate lifecycle-only history representation.
- [x] Run targeted unit and gym tests before final verification.

⚠️ The existing Docker gym test
`messages_sent_during_inference_stay_pending_until_consumed` reaches the correct pending state but
fails an unrelated pre-inference-release ordering assertion between the `Working` and background
terminal live rows. The test is unchanged; steering-specific regressions and hard-abort coverage
pass.

## Technical Contract

The legal boundary is:

`inference → complete/close every call in its batch → required compaction → steering → next inference`

Steering never suppresses threshold or context-window compaction. Compaction runs against the
fully closed pre-steering context; the steering message is then appended verbatim and is therefore
present in the exact next inference without being summarized away.

If steering arrives while a steerable tool is active, interruption is a valid
tool result and closes that call. Non-steerable calls already emitted in the
same batch must finish or receive an explicit interrupted result before
steering becomes model-visible. No inference may pass this boundary without the
accepted steering.

Provider compaction returns a replacement context. The outer agent chooses when
to request it but does not choose which messages survive. Failed or cancelled
compaction leaves the original model context active.

## Post-Completion

No deployment or migration step is required. Rig is early-stage; obsolete
compaction paths and aliases are removed directly.
