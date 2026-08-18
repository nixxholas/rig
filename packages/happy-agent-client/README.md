# `@slopus/happy-agent-client`

The client library for the Happy agent API. It replaces `rig-connect` for the new
`happy-agent` API: it connects to an endpoint, follows the stream, keeps live state in
memory, and hands it to a user interface as ordered values plus a stream of deltas.

Built on plain Web APIs so the same build runs in Node and in a browser.

What exists today is `HappyAgentClient`: a thin, faithful client for the HTTP API
specified in `packages/happy-agent/API.md`. It is built from an endpoint and a bearer
token, has one typed method per request-response route, and opens the event stream as a
typed async iterator that a caller cancels with an `AbortSignal`. It keeps no state:
caching, version reconciliation, optimistic mutations, reconnection, and the live chat
state land on top of it as the API takes shape.

The package has no runtime dependencies, and every type is hand-written from the
specification.
