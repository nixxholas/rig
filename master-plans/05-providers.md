# Master plan 5: provider protocols

## Big picture

Providers differ in credentials, endpoints, models, and a few wire-level
details, but the APIs beneath them are similar. Rig should not grow a separate
inference implementation for every provider. It should have one implementation
per protocol, with each concrete provider configuring the protocol it uses and
the capabilities or variations it supports.

Protocol implementations belong in the `protocol` area of `rig-providers`.
Provider-specific code should select and configure those implementations rather
than duplicate them.

## Responses protocols

OpenAI, Grok, and OpenAI models served through Bedrock use the Responses API
family and should share its implementation. The standard Responses API supports
WebSocket and SSE transports, including falling back from WebSocket to SSE where
appropriate. Grok appears to support only SSE; verify that instead of encoding
the assumption without evidence.

OpenAI Responses Lite is OpenAI's proprietary protocol variant. It is a separate
protocol implementation rather than a collection of exceptions spread through
the standard Responses API or the OpenAI provider.

The transport, endpoint, authentication, model capabilities, and protocol
variant are configuration of a concrete provider. Shared request construction,
stream handling, response mapping, tool calls, usage, errors, and other common
protocol behavior stay in the protocol implementation.

## Compaction

Use every native compaction mechanism a provider makes available, exclusively
in the form the provider defines. Request shape, trigger, transport, metadata,
preserved messages, opaque fields, usage, replay, and continuation semantics
belong to that protocol. Rig exposes a common result above them, but it must not
turn distinct wire protocols into one invented compaction implementation.

When a provider has no native compaction, use the provider's own compaction
prompt and continuation contract. Do not substitute a generic Rig summary.

## Validation

Exercise the shared Responses API implementation against a wider selection of
models and providers through OpenRouter. Live tests use an OpenRouter token
supplied through an environment variable; the token is never stored in the
repository. These tests should reveal real compatibility differences and turn
them into explicit protocol or provider configuration rather than duplicated
provider implementations.

## Order and criteria

First, establish the protocol implementations in `rig-providers/protocol`.
Then configure OpenAI, Grok, and OpenAI on Bedrock on top of the shared Responses
API implementation, while keeping Responses Lite separate. Finally, validate
the shared implementation through OpenRouter and record genuine differences as
configuration or clearly bounded protocol variants.

This plan is complete when providers sharing a protocol also share its
implementation; Responses API WebSocket, SSE, and fallback behavior are covered;
Grok's supported transport is verified; Responses Lite is isolated; and
OpenRouter live coverage exercises multiple models without committing
credentials. Every supported compaction path must reproduce its provider's
native or provider-defined fallback contract and successfully continue from the
result.