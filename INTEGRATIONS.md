# Integration API

Rig can expose integration-owned functions and skill instructions to a model
without installing their implementations or source files in the daemon.
Requests are stored in SQLite before they are published, remain pending across
daemon restarts, and are completed through a separate authenticated HTTP request.

## Happy mobile synchronization

Happy synchronization is an explicit daemon feature. Rig's CLI starts
`runLocalProtocolServer` with `happyIntegration: "enabled"`. Library embedders
may pass `happyIntegration: "disabled"`; omission is also fail-closed and means
disabled. The user-wide `[settings] happy_integration` config value is a second
gate and defaults to `true`; setting it to `false` disables Happy even when the
host application enables the feature. Repository `rig.toml` files cannot
change this machine-level setting. In disabled mode Rig does not load the Happy
module, search or copy credentials, register lifecycle hooks or reload handling,
create sync state, or open Happy HTTP and socket connections. Config changes
take effect after restarting the daemon.

The daemon imports the newest valid Happy credentials from `~/.happy/access.key`
into `~/.happy/rig/happy/access.key` at startup. `HAPPY_HOME_DIR` changes the source
directory. `RIG_HAPPY_SERVER_URL`, then `HAPPY_SERVER_URL`, can override the
server URL. `rig happy auth` performs Happy's QR authentication directly and
hot-reloads a running daemon without interrupting its sessions.

Every accessed primary session synchronizes automatically. Rig persists the
Happy session tag, encryption key, remote cursor, and a bounded outbound queue
in its session database. Encrypted v3 HTTP messages are authoritative; the
Happy socket only wakes synchronization. Stable message IDs make retries and
daemon recovery idempotent. Mobile text and encrypted image attachments are
submitted or steered through the same Rig session, tools, filesystem sandbox,
and permission context as terminal input. Happy model and reasoning selections
are applied before an idle session starts its next turn. The mobile stop action
invokes Rig's normal abort path, including active subprocess and subagent
cleanup.

Archiving a Rig session also archives its Happy projection. Rig immediately
sends Happy's `session-end` signal, publishes the encrypted `archived` lifecycle
metadata, calls Happy's session archive endpoint, and tears down that session's
socket and polling. Accessing the archived Rig session by ID does not reconnect
it. Restoring the session reconnects synchronization and publishes the
`running` lifecycle state again.

Rig publishes encrypted, versioned metadata with its client identity, actual
provider, provider-qualified model IDs, reasoning levels, current model and
reasoning selection, capabilities, title, Rig session status, tools, skills, MCP
servers, and bounded activity counts for subagents, workflows, background
processes, and tasks. Metadata is refreshed whenever the corresponding Rig
session event occurs. Secrets, prompts, raw tool schemas, process output, and
conversation contents are deliberately excluded.

The capability contract reports that Rig supports text, steering, images,
model selection, reasoning selection, permission selection, and abort. Rig
publishes its native `auto`, `workspace_write`, `read_only`, and `full_access`
mode IDs. Each mode includes a Rig-owned visible name and description plus a
semantic `kind` (`default`, `read-only`, `safe-yolo`, or `yolo`) that Happy can
use for its icon, color, and risk indication without owning Rig's security
semantics. Happy's
"resume" operation means launching a replacement native coding-agent CLI for
a disconnected session; Rig sessions remain owned by the daemon and reconnect
automatically, so that operation does not apply.

Happy app implementations should use `metadata.client.id` for the client badge.
Rig owns the provider and model presentation data: `metadata.providers` supplies
each provider's stable icon kind and human-readable name, and every model repeats
that descriptor alongside its visible `name`. Happy only needs to map a provider
`kind` such as `codex`, `claude`, `grok`, or `kimi` to an available icon; unknown
kinds can use its generic provider icon. `metadata.models` contains the complete
Rig catalog; each entry is identified by the pair `providerId` and `id` (`code`
is retained for Happy's existing selector), and includes `thinkingLevels` and
`defaultThinkingLevel`. The selected pair is `currentModelProviderId` and
`currentModelCode`. The relevant metadata extension is shaped as follows:

Happy should likewise prefer `metadata.operatingModes` even when `flavor` is a
known provider. The selected native Rig ID comes from `metadata.permissionMode`
or `currentOperatingModeCode`; `kind` is presentation metadata and must not be
sent back in place of `code`.

```json
{
    "rigMetadataVersion": 1,
    "client": { "id": "rig", "name": "Rig", "version": "0.0.30" },
    "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
    "providers": [
        { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
        { "id": "claude", "kind": "claude", "name": "Anthropic Claude" },
        { "id": "grok", "kind": "grok", "name": "xAI Grok" },
        { "id": "kimi", "kind": "kimi", "name": "Moonshot Kimi" }
    ],
    "capabilities": {
        "abort": true,
        "attachments": {
            "enabled": true,
            "maxBytes": 10485760,
            "mediaTypes": ["image/*"]
        },
        "files": { "browse": true, "read": true, "search": true, "write": true },
        "modelSelection": true,
        "reasoningSelection": true,
        "permissionModeSelection": true,
        "resume": false,
        "rpcMethods": ["abort", "bash", "communication", "readFile", "writeFile", "ripgrep"],
        "shell": true,
        "steering": true
    },
    "models": [
        {
            "providerId": "codex",
            "providerKind": "codex",
            "providerName": "OpenAI Codex",
            "provider": { "id": "codex", "kind": "codex", "name": "OpenAI Codex" },
            "id": "gpt-5.3-codex",
            "code": "gpt-5.3-codex",
            "name": "GPT-5.3 Codex",
            "value": "GPT-5.3 Codex",
            "contextWindow": 200000,
            "serviceTiers": ["fast"],
            "thinkingLevels": ["low", "medium", "high", "xhigh"],
            "defaultThinkingLevel": "high"
        }
    ],
    "currentModelProviderId": "codex",
    "currentModelCode": "gpt-5.3-codex",
    "permissionMode": "auto",
    "currentOperatingModeCode": "auto",
    "operatingModes": [
        {
            "code": "auto",
            "value": "Auto",
            "description": "Uses the workspace sandbox and asks before actions that need full access.",
            "kind": "safe-yolo"
        },
        {
            "code": "workspace_write",
            "value": "Workspace write",
            "description": "Allows workspace changes while blocking shell network and outside writes.",
            "kind": "default"
        },
        {
            "code": "read_only",
            "value": "Read only",
            "description": "Allows inspection without workspace changes or shell network access.",
            "kind": "read-only"
        },
        {
            "code": "full_access",
            "value": "Full access",
            "description": "Removes Rig filesystem, shell, and network restrictions.",
            "kind": "yolo"
        }
    ],
    "model": { "providerId": "codex", "id": "gpt-5.3-codex" },
    "reasoning": {
        "current": "high",
        "levels": ["low", "medium", "high", "xhigh"]
    },
    "session": {
        "status": "running",
        "permissionMode": "auto",
        "modelLocked": false,
        "serviceTier": "fast"
    },
    "thoughtLevels": [{ "code": "high", "value": "high" }],
    "currentThoughtLevelCode": "high",
    "activity": {
        "subagents": { "running": 1, "queued": 0, "total": 2 },
        "workflows": { "running": 1, "total": 1 },
        "processes": { "running": 2 },
        "tasks": { "pending": 1, "inProgress": 1, "completed": 3, "total": 5 }
    }
}
```

When Happy sends a user text record, it may attach the selected values as
`meta.model`, `meta.modelProviderId`, `meta.effort`, and `meta.permissionMode`. Rig also accepts
`meta.providerId`, `meta.reasoning`, and `meta.thinkingLevel` aliases. The
permission mode is validated as a native Rig mode and applied through the
session's normal permission path, including subagent propagation and process
shutdown when permissions are reduced. Model and reasoning selection applies
before an idle turn. A selection attached to a steering message cannot replace
the model of an already-running inference; the same persisted Happy selection
applies to the next idle turn.

A question Rig is waiting on — from `AskUserQuestion`, Codex's
`request_user_input`, Grok's `ask_user_question`, or MCP elicitation — is
published on Happy's agent-to-user communication channel, as `communications`
in the encrypted agent state, keyed by the question's request id. Rig publishes
the `form` kind: a title for clients that cannot render the payload, and one
entry per question with its options, `multiSelect`, and `allowCustom`, since
Rig accepts any answer text and not only the labels it offered. Answering a
question anywhere moves it into `completedCommunications` with the answers, so
another device settles the card it is still showing.

Happy replies with the session RPC method `{happySessionId}:communication`,
carrying the request id and either `status: "answered"` with answers keyed by
question id, or `status: "cancelled"`. Rig cannot decline a single question, so
a dismissal — including one from a client that could not render the kind —
aborts the run that asked it, which is what makes the waiting tool throw.

Happy invokes abort through the standard encrypted session RPC method
`{happySessionId}:abort`. Rig registers that method on every socket connection
and returns its normal encrypted abort result. Image attachments use Happy's
existing encrypted file event followed by user text convention. Rig downloads
and decrypts every preceding image in memory and includes it in that text
submission; it does not persist plaintext attachment bytes.

The current Happy app actually invokes `bash`, `readFile`, `writeFile`, and
`ripgrep` for its file list, file viewer/editor, Git status/diffs, and file
search. Rig implements those methods plus `abort`, and publishes the exact list
in `capabilities.rpcMethods`. Happy currently exports `listDirectory` and
`getDirectoryTree` client helpers but does not call them from its UI, so Rig
does not advertise or implement them.

Native Rig sessions use the platform-specific ripgrep binary bundled with the
Rig package, so Happy file search does not depend on `rg` being installed on the
user's `PATH`. Docker and virtual filesystem sessions use the `rg` supplied by
their controlled execution environment when the host bundle is not visible
inside that environment.
These run through the session's real Rig `AgentContext`; they therefore use the
same local-or-Docker filesystem, current permission mode, shell sandbox,
network boundary, process accounting, output limits, and abort lifecycle as the
TUI agent. File writes retain Happy's SHA-256 optimistic-concurrency contract.

## Happy2 local MCP Apps

Happy2 consumes local MCP Apps through `@slopus/rig-connect`. Its Electron main process passes
the daemon endpoint and bearer token to `connectRig`, then calls `connectPlugins`. Never send those
credentials to a renderer or open a second event stream. Protocol version 3 is required.

`onChange(apps, plugins, state)` supplies the complete catalog in navigation order. Key logical
navigation by `app.id`, but key loaded code and caches by both `app.id` and `app.generation`. A
generation change is replacement, never an in-place update.

Mounting must be instant at click time:

1. As soon as a live catalog exposes a generation, load every declared path through
   `connection.readResource(app, uri)`.
2. Verify the whole bounded bundle completed and is still the current generation.
3. Only then publish it as clickable navigation. A click performs no daemon read.
4. Serve cached bytes from a generation-specific isolated Electron origin or protocol so relative
   HTML, scripts, stylesheets, fonts, and images resolve inside the bundle. Mount a dedicated
   isolated `WebContentsView`, not a remote page.
5. Preserve the daemon policy at that origin: no default network, frames, objects, base navigation,
   or forms; bundle scripts, styles, images, and fonts are allowed, with inline styles and data
   images. Keep context isolation on and Node integration off.

The renderer implements the MCP Apps 2026-01-26 JSON-RPC 2.0 `postMessage` bridge:
`ui/initialize`, `ui/notifications/initialized`, `resources/read`, and `tools/call`. Do not inject a
global API object. Electron main derives the caller from its committed origin and calls
`connection.callTool(app, server, name, arguments, { signal })`. It may advertise the explicit
`io.slopus.happy/storage/*` extension. Do not expose arbitrary daemon paths, raw fetch, credentials,
plugin sockets, or tools absent from the app catalog.

The daemon has already bounded and validated the catalog: at most 8 apps per plugin, 64 resources
per app, 256 KiB per resource, and 1 MiB per app. Storage is JSON-only and limited to 1,024 keys,
64 KiB per value, and 5 MiB per plugin. Happy2 must still bound its own decoded/object-URL caches
to the catalog it received and must not broaden those limits.

Unmounting, removing navigation, or closing the subscription aborts prefetch and tool calls, destroys
the isolated view, and releases object URLs or custom-protocol mappings for that generation. A
stale-generation error retires the old view: unmount it, drop its bundle, and wait for the current
catalog. Never retry the old generation. Ordinary tool failures stay inside the app UI.

A clean reconnect keeps cached current generations. After a gap, retain unchanged generation keys,
prefetch new ones, and dispose missing ones. Happy2 tests should cover an event on each side of the
opening snapshot, clean resume, gap reload, replacement, uninstall, stale actions, partial-prefetch
cancellation, and last-subscriber disposal.

## HTTP proxy

The authenticated daemon connection exposes a project- or workspace-scoped
proxy tunnel:

```http
CONNECT /projects/{projectId}/proxy
CONNECT /projects/{projectId}/workspaces/{workspaceId}/proxy
Authorization: Bearer <daemon token>
```

After Rig answers `200 Connection Established`, the connection speaks the
ordinary HTTP proxy protocol: absolute-form HTTP requests and nested
`CONNECT host:port` requests both work, and request and response bodies stream
without buffering. Rig removes proxy and hop-by-hop headers while preserving
upstream `Authorization`.

Putting the folder scope in this URL lets an Electron main process bind one
ephemeral loopback proxy per project or workspace, pass its ordinary
`http://127.0.0.1:<port>` URL to `session.setProxy()`, and pipe each accepted
browser connection through the authenticated Rig tunnel. Chromium does not
preserve path, query, or arbitrary headers in its proxy server setting, so the
loopback bridge owns that final URL-to-tunnel mapping.

The proxy is a host-side project service. It remains available before a chat
exists and does not inherit a chat's execution environment or lifecycle.

## Direct project and workspace files

`GET /projects/{projectId}/file?path={path}` reads binary file bytes from a
project. Add `/workspaces/{workspaceId}` before `/file` to target a workspace:

```json
{ "content": "<base64>", "hash": "<sha256>" }
```

`PUT` to the same URL replaces or creates a file:

```json
{
    "path": "path/to/file",
    "content": "<base64>",
    "expectedHash": "<sha256 or null>"
}
```

Use the hash returned by `GET` to replace the exact version that was read. Use
`null` only when creating a file expected not to exist. A concurrent change
returns HTTP 409. Paths are confined to the selected project or workspace;
writes use Rig's workspace boundary and reject protected Git control files.
File payloads are limited to 32 MB. File search follows the same scope at
`GET .../files?query={query}&limit={limit}`. None of these operations requires
or consults a Session.

## Submit a configured message

`POST /sessions/{sessionId}/messages` accepts the normal message fields plus:

```json
{
    "text": "Resolve ticket 42",
    "systemPrompt": "You are the support automation agent.",
    "externalTools": [
        {
            "name": "lookup_ticket",
            "description": "Look up a support ticket.",
            "parameters": {
                "type": "object",
                "properties": { "ticket": { "type": "number" } },
                "required": ["ticket"],
                "additionalProperties": false
            }
        }
    ],
    "skills": [
        {
            "name": "support-workflow",
            "description": "Resolve support tickets using the team's workflow.",
            "location": "durable"
        }
    ]
}
```

When present, `systemPrompt` replaces Rig's assembled prompt; `null` restores
Rig's normal prompt. Durable skill catalog instructions are appended when
`skills` is non-empty. When present, `externalTools` replaces the session's prior
external function set. An empty array disables all external functions. The JSON
Schema in `parameters` is forwarded to the provider unchanged. When present,
`skills` replaces the session's integration-owned skill set. Every supplied
skill must use `"location": "durable"`; an empty array disables durable skills.
Rig adds their metadata to the skills catalog without fetching their bodies.

Use `POST /messages` with either `"all": true` or a non-empty `sessionIds`
array to submit the same configured message to multiple primary sessions. IDs
must be unique, and a single broadcast is bounded to 500 sessions.

## Consume durable calls

Pending work is available from `GET /external-tool-calls` and through the
`external_tool_call_requested` session/global event. Each call includes its
stable `id`, `sessionId`, `runId`, provider `toolCallId`, function definition,
and arguments.

Complete a call with:

```text
POST /sessions/{sessionId}/external-tool-calls/{id}
```

When the model chooses a durable skill, Rig invokes its built-in `read_skill`
tool. The resulting external call also includes the selected `skill` metadata.
Complete that call with the full `SKILL.md` text:

```json
{
    "status": "completed",
    "output": "---\nname: support-workflow\ndescription: Resolve support tickets.\n---\n\n# Workflow\n..."
}
```

The contents are returned to the model as the `read_skill` result. Failed skill
loads use the same failure shape as external functions. Durable skills currently
cover `SKILL.md` itself; references to other integration-owned resources require
an integration-provided access mechanism.

Successful JSON output:

```json
{ "status": "completed", "output": { "state": "resolved" } }
```

Successful multimodal output may use `content` with Rig text/image content
blocks instead of `output`. Failures use:

```json
{
    "status": "failed",
    "error": { "message": "Ticket service unavailable", "code": "unavailable" }
}
```

Repeating an identical callback is idempotent and returns `accepted: false`.
A conflicting second result returns HTTP 409. Immediate functions in a model
tool batch finish first; durable external functions are then published in
parallel as a barrier. The model continues only after every durable call in
that batch has resolved.

Rig retains the latest 1,000 completed or cancelled calls per session for
callback idempotency and history. Pending and completed-but-not-yet-consumed
calls are never pruned.

External functions and durable skill reads cross a boundary that Rig cannot
sandbox. They therefore require Auto or Full access, and Auto reviews each
invocation before publishing it. The daemon bearer token is required for every
endpoint above.
