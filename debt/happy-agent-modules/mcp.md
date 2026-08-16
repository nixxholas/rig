# Module report: mcp

Reviewed: `packages/happy-agent-modules/sources/mcp/` — `README.md`, `Mcp.ts`, `McpHost.ts`,
`McpModule.ts`, `createMcpTool.ts`, `createMcpProtocolTools.ts`, `describeMcpAutoPermissionAction.ts`,
`tools/list_mcp_servers.ts`, and the supporting `impl`-style helpers (`mcpResultToContentBlocks.ts`,
`mcpPageAssertions.ts`, `handleMcpElicitation.ts`, `normalizeMcpName.ts`, `humanizeMcpName.ts`,
`quoteVisibleExact.ts`, `isMcpErrorResult.ts`, `mergeMcpTools.ts`, `fingerprintMcpServer.ts`,
`createMcpTrustUserInputRequest.ts`, `createProjectMcpSecurityNotice.ts`, `index.ts`).
Scope: read-only review of the v2 successor to `packages/rig/sources/mcp/`, against that v1 baseline
and the root `AGENTS.md` sections on MCP and on permissions.

## Summary

This is the strongest of the five modules on the axis that matters most: it is the one place in
`happy-agent-modules` where the security rules in `AGENTS.md` are followed literally and visibly.
Every MCP-derived tool declares `requiresAutoOrFullAccess: true`; every tool that actually reaches a
server with model-chosen arguments (`call_mcp_tool`, `get_mcp_prompt`, and each direct
`mcp__server__tool`) declares `shouldReviewInAutoMode: () => true`; server-supplied annotations are
explicitly rejected as trust input at `createMcpTool.ts:47-49`; and nothing in the module declares
`shouldRunInFullAccessInAutoMode`, so review is never used as a back door to sandbox elevation. The
Auto-permission description at `describeMcpAutoPermissionAction.ts:19` discloses the external
boundary and escapes model-supplied text — it is better on that point than v1's own
`get_mcp_prompt`.

The problems are two kinds of rewrite debt. Three protections v1 had did not survive the port
(per-server locks, per-call timeouts, `toUI`), and four helpers were carried across but left
unwired (`mergeMcpTools`, `fingerprintMcpServer`, `createMcpTrustUserInputRequest`,
`createProjectMcpSecurityNotice`) while `README.md` describes them as part of the module's
contract. On top of that sit a set of self-inflicted bounds and defensive constructs new to v2 — a
128-character cap on resource URIs, a qualified tool name with no length bound, a write-only durable
index table, a formatter that throws rather than degrade, and a `runtimeOptions`/`assertMcpHost`
pair whose only purpose is to make a class instance pass a TypeBox check.

## Changes from the Rig v1 implementation

The v2 boundary is the headline change and it is a good one. `Mcp.ts:4-8` states it: the module
deliberately avoids importing the MCP SDK and receives protocol values through an injected
`McpHost`, leaving transports, credentials, configuration, and the trust store on the Rig side.
That makes the protocol surface testable and provider-neutral in a way v1's SDK-coupled
`packages/rig/sources/mcp/` is not. The pure helpers (`normalizeMcpName`, `humanizeMcpName`,
`isMcpErrorResult`, `mcpResultToContentBlocks`, and the rest) were carried over unchanged, which is
the low-risk way to port them; the open question is when v1's copies get retired so the two cannot
drift.

Protections that did not survive the port:

- v1's `createMcpTool.ts` sets `locks: [\`mcp:${options.serverName}\`]`; v2's does not, so
  concurrent calls to the same server are no longer serialized.
- v1 sets a per-call `timeoutMs`; v2 has none, so a hung server now hangs the turn.
- v1 supplies `toUI`; v2's tool renders only `toLLM`, so the user-facing rendering is lost.

## Findings

1. **Four ported files are unwired but documented as if live.**
   `mergeMcpTools.ts:16`, `fingerprintMcpServer.ts:15`, `createMcpTrustUserInputRequest.ts:11`, and
   `createProjectMcpSecurityNotice.ts:8` define functions that no other file in
   `sources/mcp/` calls; they are only re-exported from `sources/mcp/index.ts` (`:158-178`).
   `README.md:65-68` nonetheless describes `fingerprintMcpServer`,
   `createMcpTrustUserInputRequest`, and `createProjectMcpSecurityNotice` as part of the module's
   behaviour. Either the rewrite has not finished wiring the trust path yet, or these should not
   have come across; as it stands, someone auditing MCP trust wording will find it here and
   reasonably conclude this copy is the one in force.

2. **`MAX_MCP_URI_LENGTH = 128` (`Mcp.ts:14`) is too small for real MCP resource URIs.** Resource
   URIs routinely carry paths, query strings, or encoded identifiers well past 128 characters. The
   bound is enforced at the schema layer, so the failure mode is a hard rejection of a
   protocol-legal server response, not a truncation. Compare `MAX_MCP_DESCRIPTION_LENGTH = 16_384`
   on the line above — the URI cap is two orders of magnitude tighter than the description cap for
   the field that is far more likely to be long and is not optional.

3. **The qualified tool name is unbounded.** `createMcpTool.ts:30` builds
   `` `mcp__${normalizeMcpName(serverName)}__${normalizeMcpName(tool.name)}` `` with no length
   check, while `Mcp.ts:11-12` permits 128 characters each for the server and tool names. The
   result can be 262 characters — longer than the tool-name limits several providers enforce, and
   the module has already validated both inputs, so it is aware of the sizes at that point.

4. **`mcp_module_index` is write-only.** The table is created at `McpModule.ts:92`, cleared at
   `:161`, and repopulated at `:182` on every `beforeAgentLoop`; a grep across `sources/` shows no
   read. The comment at `:145-148` justifies it as serving "prompt projections and restart
   diagnostics", but no prompt projection and no diagnostic reads it. It is a per-turn
   delete-and-reinsert of every configured server inside the caller's transaction, purchased for
   nothing.

5. **Every turn re-enumerates every server and every tool.** `McpModule.ts:197-239` calls
   `#listAllServers`, then `#listAllTools` per connected server, then constructs a fresh
   `createMcpTool` for each — on each `tools()` invocation, i.e. each agent loop. Combined with
   finding 4 this means two full catalog walks per turn. The comment at `:193-196` argues the list
   must be rebuilt from the host's current catalog, which is a good reason not to cache a *client*;
   it is not a reason to re-fetch an unchanged catalog rather than let the host answer from its own
   connection state.

6. **Catalog overflow and name collision are thrown, not degraded.** `McpModule.ts:212-213` throws
   `"MCP tool catalog exceeded its bound."` and `:217-220` throws on post-normalization collision.
   Both are conditions caused entirely by third-party server configuration, and both abort tool
   assembly for the whole agent — a single misconfigured server with two tools that normalize
   identically takes down every other server's tools as well.

7. **`runtimeOptions` and `assertMcpHost` exist only to defeat TypeBox.**
   `McpModule.ts:675-703` rebuilds the options object, respreading each host method onto a fresh
   literal (`callTool: host.callTool, getPrompt: host.getPrompt, …`) and ends in an `as
   McpModuleOptions` cast; `McpHost.ts:93-113` does the same for the host. The purpose is to move
   prototype methods onto own properties so `Value.Check` will accept a class instance. Since
   `Type.Function` only verifies `typeof === "function"`, the entire construction buys a check that
   the host has eight properties that are functions — for an object the embedder constructed and
   passed in directly. This is over-validation of a trusted internal contract, paid for with a cast
   that discards the type safety the check was supposed to add.

8. **String-or-object overloads on the public operations.** `listTools` (`McpModule.ts:311-334`) and
   `listResources` (`:364-387`) each branch on whether the argument is a string or a query object
   and return either a bare array or a page accordingly. `README.md:70-73` presents
   `listToolPage`/`listTools` and `listResourcePage`/`listResources` as parallel pairs, which makes
   the overload redundant: there is already a paged entry point, so the array form's polymorphism
   only creates a call site whose return type depends on argument shape.

9. **`formatIdentityRows` throws when output cannot fit.** `McpModule.ts:753-754` throws
   `"MCP model output cannot fit a complete identity."` and `:775-776` throws
   `"MCP model output cannot fit its continuation cursor."`. `README.md:59-62` states this as an
   intentional guarantee. The intent — never show the model a truncated server name or URI it might
   then use — is sound, but the chosen failure is an exception that surfaces as a tool error for a
   condition (one very long resource URI plus a long cursor) that a third-party server controls.
   Note this interacts with finding 2: the 128-character URI cap is the only reason this path is
   currently hard to hit.

10. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still name
    `@slopus/happy-agent-features` as the home for ready-made capabilities and never mention
    `happy-agent-modules`.

## What it gets right

- **The MCP permission rules in `AGENTS.md` are implemented exactly.** Every tool the module
  produces — the direct `mcp__*` tools (`createMcpTool.ts:40`) and all protocol tools
  (`createMcpProtocolTools.ts`) — declares `requiresAutoOrFullAccess: true`, correctly treating an
  MCP call as execution outside the workspace boundary.

- **Server annotations are treated as untrusted.** `createMcpTool.ts:47-49` states in a comment that
  "Server annotations such as `readOnlyHint` are untrusted metadata" and unconditionally returns
  `shouldReviewInAutoMode: () => true`. This is precisely the rule `AGENTS.md` states, and it is
  implemented as an unconditional predicate rather than a defaulted option that a future caller
  could flip.

- **Review is never coupled to elevation.** No file in the module declares
  `shouldRunInFullAccessInAutoMode`. MCP calls are reviewed because they cross a trust boundary,
  not because they need sandbox escape — the distinction `AGENTS.md` insists on, and the one the
  `imageGeneration` and `compute` modules were less careful about.

- **The review split across protocol tools is principled.** `call_mcp_tool` and `get_mcp_prompt`
  review; `list_mcp_tools`, `list_mcp_resources`, `list_mcp_resource_templates`,
  `list_mcp_prompts`, and `read_mcp_resource` return `shouldReviewInAutoMode: () => false`. These
  are intrinsically read-only protocol operations against an already-trusted, already-connected
  server, which `AGENTS.md` permits, and the module did not blanket-review everything to look safe.

- **The Auto-permission description improves on v1.**
  `describeMcpAutoPermissionAction.ts:19` names the server, discloses that the action leaves the
  local boundary, and routes model-supplied text through `quoteVisibleExact` — where v1's
  `get_mcp_prompt` (`packages/rig/sources/mcp/createMcpProtocolTools.ts:256`) does not.

- **The SDK boundary is real and well-stated.** `Mcp.ts:4-8` explains why the package models the
  protocol as plain values behind an injected `McpHost` instead of importing the SDK, and the code
  honours it: the module never caches a client, never owns a transport, and never makes a trust
  decision — `McpModule.ts:193-196` says so explicitly and the code matches. This is the clearest
  architectural gain of the rewrite.

- **Page responses from the host are validated before use.** `mcpPageAssertions.ts` checks page
  identity, requested limit, duplicate records, and non-advancing cursors. Unlike the TypeBox checks
  in finding 7, this is validation of genuinely foreign input (a third-party server's pagination)
  and is the right place to spend it — a non-advancing cursor is a real infinite-loop hazard.
