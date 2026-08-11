# Master plan 16: tools

## Big picture

A model receives one explicit list of ordinary Rig tools. That list defines its
behavior. Tool selection is fixed arrays, merged together where needed. Rig
must not classify models or tools into invented capability groups such as
search models, filesystem models, or models with one detected feature.

Common tools have one definition shared by every model. Vendor-shaped tools
have separate definitions and are never reused between vendors. `web_fetch` is
a common Rig tool for every model.

## Search tools

All Rig-owned search wrappers live together in
`packages/rig/sources/tools/search/`. The common `web_fetch` tool lives there as
well. This module owns the ordinary tools `web_fetch`, `gemini_web_search`,
`codex_web_search`, `claude_web_search`, `grok_web_search`, and
`grok_x_search` as the product needs them. There is no combined `grok_search`;
web and X search remain separate definitions.

Each search tool is a separate complete definition. Similar purpose does not
make two definitions interchangeable: names, descriptions, argument schemas,
result schemas, prompts, result handling, presentation, and tests may all
differ. Do not create a cross-vendor search definition factory or reuse one
vendor's schema or description for another vendor.

A vendor-specific search wrapper exposed to other models uses a vendor-prefixed
name. Search arrays are written explicitly and merged into the model's ordinary
tool array. Do not discover search capabilities from models, provider features,
tool names, or a registry of search kinds.

When more than one configured provider can back the same vendor search tool,
the tool's argument schema and description list every available provider ID.
The tool requires `provider_id` so the model chooses the account explicitly.
The field is optional only when the current provider is one of those routes; in
that case omitting it selects the current provider. With one available route,
`provider_id` is optional.

## Server tools stay inside providers

Server tools are a provider implementation detail. Keep their descriptors,
selection, wire format, calls, results, citations, and replay inside
`happy-providers`. The provider is responsible for writing server-tool calls and
results into its native history representation correctly and replaying them on
later turns.

Inside `happy-providers`, a server tool uses an optional native descriptor field
whose required member is `type`, for example
`server: { type: "web_search" }`. The descriptor may carry any additional
vendor wire fields it needs. Provider mappers pass this exact descriptor
instead of deriving a native type from the tool name.

Rig may persist and return opaque provider response items so the provider's
native history survives. Common layers do not parse, classify, present, or
reinterpret those items as server tools.

Do not add a common `ServerTool` type, server-tool events, server-tool calls,
server-tool results, or server-tool presentation to `rig-execution`, the agent
loop, Rig protocols, persistence, or clients. When provider events are marked
`server: true`, `Executor` drops the call and every related delta, completion,
and result event. It does not execute, project, store, or forward any of them;
outside the provider the call is treated as if it does not exist.

`tool_search` is the other provider-only service-tool category. Its descriptor
and vendor items remain inside the provider that implements it. Do not lift
`tool_search` into the common executor or Rig tool contract.

## Bounded side inference

The main conversation and normal agent inference use `Executor`. Bounded side
inference does not. A one-off summarization, wrapped web or X search, or similar
single-purpose call directly creates one provider inference with an explicit
model configuration and tool list, manually consumes the provider stream and
vendor items it needs, and closes the temporary session.

Bounded side inference must not use `Executor`, the agent loop, a session
manager, or the normal tool-execution loop. It is a small direct provider call,
not a hidden conversation.

## Vendor truth and golden traces

Tool descriptors and captured golden traces in `happy-providers` are evidence of
the vendor's real surface and wire protocol. Product code must conform to them.
Do not edit, normalize, or customize vendor descriptors to fit a Rig
abstraction.

Never delete a golden trace. Never skip, weaken, rewrite, regenerate, truncate,
or otherwise modify provider tests or fixtures in order to avoid matching the
golden traces. When product behavior disagrees with a golden trace, fix product
code or the narrow provider adapter; do not erase or relax the evidence.

## Order and criteria

First, restore server tools and `tool_search` to provider-only concerns and
remove their common Executor, agent, protocol, and client representations.
Then create the ordinary search wrappers in `tools/search` and the common
`web_fetch` tool. Finally, assemble every model surface from fixed common and
vendor arrays and run bounded search work through direct one-off provider
inference.

This plan is complete when:

- every model receives one explicit merged array of ordinary Rig tools;
- `web_fetch` is one common tool available to every model and lives in
  `packages/rig/sources/tools/search/`;
- all Rig-owned search wrappers live in `packages/rig/sources/tools/search/`
  and cross-vendor definitions share no schema, description, prompt, or
  definition factory;
- no model or provider capability classification decides which tools exist;
- server tools and `tool_search` exist only inside `happy-providers`, and
  `Executor`, agents, protocols, persistence, and clients do not model them;
- providers record server-tool calls and results in their native history and
  replay them correctly through opaque provider response items;
- provider descriptors remain faithful to the vendor, golden traces remain
  present, and provider tests continue to match them without weakened coverage;
- bounded side inference uses one direct, correctly configured provider call
  whose response is handled locally without `Executor`.
