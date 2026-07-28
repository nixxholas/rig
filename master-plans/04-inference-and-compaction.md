# Master plan 4: inference and compaction

## Big picture

The agent loop is a simple loop that runs inference on a provider. Providers
are stateful: a session holds the chat history it has already sent and compares
it against the history the caller passes in. If the new history only grows the
old one, the session continues forward; anything else and the session is
rebuilt inside the provider.

That cache puts obligations on us from the outside. Nothing may run in
parallel — not two inferences, not an inference and a compaction. And every
tool call must be closed on time; there must never be a tool call left open.

## The loop

One turn works like this: run inference and stream it. When inference
finishes, collect every tool the model tried to call and execute them in
parallel. Write all the tool results. Only after that may we run compaction,
if we noticed we exceeded the session size.

## Compaction

Compaction is just a new message type — nothing scary. One message that holds
the list of IDs of the previous messages it replaces, the kind of compaction,
and the message to add: whatever structure explains how to assemble the
context. That structure depends on the provider.

The message also carries statistics: how big the context was and how big it
became. The size before is exact: every vendor returns provider-reported usage
on the compaction request itself, and input plus cache read plus cache write
is exactly the context being compacted. The size after is not reported by the
compaction call; it becomes exact on the first inference that follows, and
until then only a local estimate exists. Rig currently throws that usage away;
keep it. It would be great to see how much the context shrank.

We must preserve all encrypted fields, and we always use native compaction
when it is possible. Where it is not, we still use the provider's prompts —
and almost all the good models encrypt anyway, except the open ones.

## Criteria

- Inference and compaction are strictly serialized from the outside; a session
  never sees two runs at once.
- Every tool call is closed before the next inference starts.
- Compaction is a single message in the history that carries the IDs of the
  messages it replaces, its provider-dependent assembly structure, and the
  before and after statistics.
- Encrypted fields survive verbatim, and native compaction is used whenever
  the provider offers it.
