# happy-plugins

`happy-plugins` is the public TypeScript SDK for writing local Happy plugins.

A plugin imports one ready-to-use client:

```ts
import { happy } from "happy-plugins";

const projects = await happy.projects.list();
console.log(`Happy has ${projects.length} projects.`);
```

Happy supplies the connection automatically when it starts the plugin. Plugin code does not
open a daemon connection, find credentials, or depend on Happy's internal protocol.

## Status

The SDK is an early preview. The current surface covers projects, workspace commands and files,
sessions, messages to agents, provider usage, MCP tool contributions, and local application
contributions.

## How authoring and runtime versions work

Install the published package while authoring for editor completion and local type checking:

```sh
pnpm add --save-dev happy-plugins typescript@^7.0.2 @types/node
```

This installation is an authoring dependency. At runtime, Happy compiles the plugin with
TypeScript 7 and substitutes the copy of `happy-plugins` shipped with that Happy installation. The
daemon's build is the final compatibility check. A plugin cannot accidentally run against a
different SDK from the one its daemon implements.

Happy itself does not require a plugin to have a `package.json` or its own SDK installation. A
TypeScript entry file, manifest, and PNG icon are enough.

## Create a plugin

A plugin is installed into its own folder inside Happy's managed home:

```text
~/.happy/rig/plugins/project-counter/
├── happy.plugin.json
├── icon.png
└── index.ts
```

Happy keeps everything it generates for the plugin under `.build/` in that same folder.

The installation root can be overridden with the absolute `HAPPY_PLUGINS_DIRECTORY` environment
variable.

### `happy.plugin.json`

The manifest is intentionally small and exact:

```json
{
    "name": "Project Counter",
    "description": "Reports how many projects Happy knows about.",
    "version": "1.0.0",
    "entry": "index.ts",
    "icon": "icon.png",
    "apps": [
        {
            "id": "overview",
            "title": "Project overview",
            "root": "app",
            "page": "index.html",
            "sidebar": { "label": "Projects", "order": 10 }
        }
    ]
}
```

`name`, `description`, `entry`, and `icon` are required. `version` and `apps` are optional. Extra
fields are rejected.

- `name`: a non-empty human-readable name.
- `description`: a non-empty explanation of the plugin.
- `version`: a Semantic Versioning string. An omitted version is treated as `0.0.0`.
- `entry`: a relative path to a `.ts` file inside the plugin folder.
- `icon`: a relative path to a PNG file inside the plugin folder.
- `apps`: up to 8 immutable static MCP Apps, each with a stable ID, resource root, HTML page,
  sidebar metadata, and optional image icon.

Entry and icon paths must remain inside the plugin folder. The entry and icon themselves must be
ordinary files rather than symbolic links. Happy does not register a plugin whose manifest or
icon is invalid.

### `index.ts`

```ts
import { happy } from "happy-plugins";

const sessions = await happy.sessions.list();

console.log(`The plugin can see ${sessions.length} sessions.`);

// Keep a service-style plugin alive until Happy shuts it down.
await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
});
```

The entry is an ES module and may use top-level `await`. Relative TypeScript imports are supported.

Ask an agent to install the folder and Happy validates the manifest, compiles the TypeScript, and
starts the plugin right away. Uninstalling stops it and keeps the folder it writes to. Happy also
loads every installed plugin when the daemon starts.

## Develop without Docker

`happy-plugins` includes the same TypeBox schemas and Unix-socket client used by Rig plus an
in-memory fake Happy host. The one-command runner starts a TypeScript source plugin with that host,
prints every request and registration, lists its MCP tools, and can call one:

```sh
pnpm happy-plugin dev ./index.ts \
  --seed ./happy.plugin.dev.json \
  --list-tools \
  --call "Project tools/list_projects" \
  --arguments '{}'
```

The runner uses Node's native TypeScript stripping and requires Node 22.6 or newer. It does not
install, start, or require Docker. Its short-lived socket, writable plugin directory, and other
host state live below the operating-system temporary directory, not beside the plugin source. The
runner removes that root on normal exit and on `SIGINT` or `SIGTERM`.

A seed file uses the SDK's exported project, workspace, and session schemas:

```json
{
    "projects": [
        {
            "id": "project-1",
            "name": "Rig",
            "path": "/workspace/rig"
        }
    ],
    "workspaces": [],
    "sessions": []
}
```

For tests that need direct control, use the same host programmatically:

```ts
import { createHappyPluginTestHost } from "happy-plugins";

const host = await createHappyPluginTestHost({
    projects: [{ id: "project-1", name: "Rig", path: "/workspace/rig" }],
});

try {
    const projects = await host.client.projects.list();
    console.log(projects, host.requests, host.mcp.listTools());
} finally {
    await host.close();
}
```

`host.mcp.waitForTools()`, `host.mcp.listTools()`, and `host.mcp.callTool()` let a test observe and
exercise model-visible MCP contributions without reaching into Rig internals.
`host.apps.callTool()` exercises app-visible tools, while `host.apps.storage` mirrors the bounded
JSON storage extension. The development runner validates a colocated `happy.plugin.json` and all
declared app bundles before it starts plugin code. Seed `providerUsage` to exercise
`happy.providers.usage()` without a real account. The host creates
`host.environment.HAPPY_PLUGIN_DIRECTORY` before the plugin starts, so tests can use it for
persistent state exactly as they use the production directory. `host.rootDirectory` identifies the
temporary root and `host.close()` removes it. Pass `{ temporaryDirectory }` as the second argument
when a test sandbox requires a writable temporary parent; the host still creates and cleans its own
child root there.

## Runtime model

Each plugin runs in its own process under Happy's existing command sandbox, and every plugin owns
one writable folder:

```text
macOS: ~/Happy/Plugins/project-counter/
Linux: ~/happy/plugins/project-counter/
```

Happy creates that folder, starts the plugin with it as the working directory, and confines the
sandbox to it. Write state there and nowhere else.

Happy injects these environment variables:

| Variable                   | Meaning                                        |
| -------------------------- | ---------------------------------------------- |
| `HAPPY_PLUGIN_DIRECTORY`   | Absolute path to the plugin's writable folder. |
| `HAPPY_PLUGIN_SOCKET_PATH` | Private Unix socket used by the SDK.           |
| `HAPPY_PLUGIN_TOKEN`       | Per-process bearer token used by the SDK.      |

Normal plugin code should use the exported `happy` client and does not need to read the socket or
token directly.

Happy captures stdout and stderr for the current run in `.build/plugin.log` inside the installed
plugin folder. That file retains the most recent 1 MiB rather than freezing at its earliest output,
and it resets when a new plugin process starts. Generated runtime state below `.build/` and
`.runtime/` should not be edited or distributed.

Rig exposes the newest useful 16 KiB snapshot through `/plugins <name>`, the `plugin_logs` agent
tool, the local protocol, and `rig-connect`, with `truncated` set when older retained output was
omitted. A plugin is reported explicitly as running, stopped, or failed to build; logs are
snapshots, not an unbounded stream or polling API.

## API

```ts
import { happy } from "happy-plugins";
```

All methods return promises. Inputs and daemon responses are validated with TypeBox at runtime.

### Plugins

```ts
const plugins = await happy.plugins.list();
const current = plugins.find((plugin) => plugin.isSelf);
```

Each entry contains the installed folder, human-readable name, current daemon state, normalized
manifest version, and whether it represents the calling plugin. A manifest without a version is
reported as `0.0.0`:

```ts
type HappyPlugin = {
    folder: string;
    isSelf: boolean;
    name: string;
    state: "running" | "stopped" | "build_failed";
    version: string;
};
```

### Projects

```ts
const projects = await happy.projects.list();
```

Signature:

```ts
happy.projects.list(): Promise<readonly HappyProject[]>
```

`HappyProject` contains:

```ts
type HappyProject = {
    id: string;
    name: string;
    path: string;
    archivedAt?: number;
};
```

### Workspaces

List every workspace, or only workspaces belonging to one project:

```ts
const all = await happy.workspaces.list();
const projectWorkspaces = await happy.workspaces.list({ projectId: "project-id" });
```

Create a managed workspace:

```ts
const workspace = await happy.workspaces.create({
    projectId: "project-id",
    name: "Investigate parser",
    // baseRef: "main",
});
```

Rename or archive a workspace using its current version:

```ts
const renamed = await happy.workspaces.rename({
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    name: "Fix parser",
    version: workspace.version,
});

await happy.workspaces.archive({
    projectId: renamed.projectId,
    workspaceId: renamed.id,
    version: renamed.version,
});
```

Run a non-interactive Bash command in a workspace, or read and write UTF-8 files relative to its
root:

```ts
const result = await happy.workspaces.exec({
    workspaceId: workspace.id,
    command: "pnpm test",
    timeoutMs: 60_000,
});

await happy.workspaces.files.write({
    workspaceId: workspace.id,
    path: "reports/plugin.txt",
    content: result.stdout,
});

const report = await happy.workspaces.files.read({
    workspaceId: workspace.id,
    path: "reports/plugin.txt",
});
```

Commands default to a 30-second timeout, are capped at 5 minutes, and return `exitCode`, `stdout`,
`stderr`, `timedOut`, `stdoutTruncated`, and `stderrTruncated`. Standard output and standard error
each have an independent 1 MiB cap, so each truncation flag reports only bytes dropped from that
stream. File contents are capped at 1 MiB, and traversal or symlink escapes outside the selected
workspace are rejected.

Signatures:

```ts
happy.workspaces.list(input?: {
    projectId?: string;
}): Promise<readonly HappyWorkspace[]>

happy.workspaces.create(input: {
    projectId: string;
    name: string;
    baseRef?: string;
}): Promise<HappyWorkspace>

happy.workspaces.rename(input: {
    projectId: string;
    workspaceId: string;
    name: string;
    version: number;
}): Promise<HappyWorkspace>

happy.workspaces.archive(input: {
    projectId: string;
    workspaceId: string;
    version: number;
}): Promise<HappyWorkspace>

happy.workspaces.exec(input: {
    workspaceId: string;
    command: string;
    timeoutMs?: number;
}): Promise<ExecuteWorkspaceCommandResult>

happy.workspaces.files.read(input: {
    workspaceId: string;
    path: string;
}): Promise<{ content: string; bytes: number }>

happy.workspaces.files.write(input: {
    workspaceId: string;
    path: string;
    content: string;
}): Promise<{ bytesWritten: number }>
```

Workspace mutations use optimistic versions. Pass the `version` from the most recently returned
workspace.

`HappyWorkspace` contains:

```ts
type HappyWorkspace = {
    id: string;
    projectId: string;
    name: string;
    path: string;
    status: "initializing" | "ready" | "failed" | "archiving" | "archived";
    version: number;
    baseRef?: string;
    error?: string;
    archivedAt?: number;
};
```

### Sessions

```ts
const sessions = await happy.sessions.list();

const session = await happy.sessions.create({
    cwd: "/absolute/path/to/workspace",
    // providerId: "codex",
    // modelId: "openai/gpt-5.6-sol",
    // effort: "medium",
    // appendSystemPrompt: "Concentrate on the parser.",
    // workspaceId: "workspace-id",
});
```

Signatures:

```ts
happy.sessions.list(): Promise<readonly HappySession[]>

happy.sessions.create(input: {
    cwd: string;
    providerId?: string;
    modelId?: string;
    effort?: string;
    appendSystemPrompt?: string;
    workspaceId?: string;
}): Promise<HappySession>
```

`HappySession` contains:

```ts
type HappySession = {
    id: string;
    agentId: string;
    cwd: string;
    projectId: string;
    status: string;
    archived: boolean;
    title?: string;
    workspaceId?: string;
};
```

### Messages to agents

Use the stable `agentId` returned by `happy.sessions.list()` or `happy.sessions.create()`:

```ts
const [session] = await happy.sessions.list();

if (session !== undefined) {
    const delivery = await happy.agents.sendMessage({
        agentId: session.agentId,
        message: "The plugin finished indexing the project.",
    });

    console.log(`Delivered to session ${delivery.sessionId}.`);
}
```

Signature:

```ts
happy.agents.sendMessage(input: {
    agentId: string;
    message: string;
}): Promise<{
    delivered: true;
    runId: string;
    sessionId: string;
}>
```

### Provider usage

Applications can read every configured account without knowing which providers exist:

```ts
const providers = await happy.providers.usage();

for (const entry of providers) {
    console.log(entry.providerId, entry.usage?.windows.weekly?.usedPercent, entry.error);
}
```

`happy.providers.usage()` returns `readonly HappyProviderUsageEntry[]`. Each entry identifies the
configured account, last check, and error, plus a provider-neutral snapshot or `null`. A snapshot
has a canonical vendor kind, plan name, exhaustion state, optional credits, and optional
five-hour, weekly, and monthly windows. Render the entries received rather than assuming a
provider or plan exists.

### MCP Apps

Apps are static resources declared in `happy.plugin.json`; plugin code does not start or register
them. Rig validates and snapshots each folder before starting the plugin:

```json
"apps": [{
    "id": "account-overview",
    "title": "Account overview",
    "root": "app",
    "page": "index.html",
    "sidebar": { "label": "Accounts", "order": 10 }
}]
```

Rig derives an official `ui://` URI and serves the page as
`text/html;profile=mcp-app`. The page uses the MCP Apps 2026-01-26 JSON-RPC bridge: `ui/initialize`,
`ui/notifications/initialized`, `resources/read`, and `tools/call`. There is no injected global API.

Backend behavior is an ordinary MCP tool. Set its official visibility when only the app should see
it; omitting `visibility` defaults to both audiences:

```ts
defineMcpTool({
    name: "refresh",
    description: "Refresh account usage for the mounted app.",
    visibility: ["app"],
    inputSchema: Type.Object({}, { additionalProperties: false }),
    async execute() {
        return { content: [{ type: "text", text: "ready" }] };
    },
});
```

The host also advertises explicit `io.slopus.happy/storage/{get,set,delete,list}` methods. Those
methods are a Happy extension, not part of standard MCP Apps.

Each plugin may declare at most 8 apps. An app contains at most 64 published resources, each at
most 256 KiB, and at most 1 MiB in total. Hidden authoring debris such as `.DS_Store` is ignored;
symlinks, unsafe resource paths, unsupported media types, missing pages/icons, and non-image icons
are rejected before plugin code starts.

Storage keys are safe lowercase IDs (128 characters maximum). A plugin may hold at most 1,024
keys, 64 KiB per JSON value, and 5 MiB in total. Values use JSON semantics—`undefined`, `bigint`,
cycles, and other non-JSON values are rejected. Writes are atomic, crash leftovers are cleaned,
and storage survives plugin restarts in the plugin's writable folder.

### MCP tools

No MCP server package or other author dependency is needed. Reuse the `Type` export from
`happy-plugins` so tool input types and runtime validation stay together:

```ts
import { defineMcpTool, happy, Type } from "happy-plugins";

await happy.mcp.startServer({
    name: "Project tools",
    tools: [
        defineMcpTool({
            name: "list_projects",
            description: "List the projects visible to this plugin.",
            inputSchema: Type.Object({}, { additionalProperties: false }),
            async execute(_input, { signal }) {
                signal.throwIfAborted();
                const projects = await happy.projects.list();
                return {
                    content: [{ type: "text", text: JSON.stringify(projects) }],
                };
            },
        }),
    ],
});
```

Rig gives the tool a stable name derived from the plugin, server, and tool names and offers it in
ordinary projects everywhere. Calls use the same MCP permission path as configured MCP servers:
they require Auto or Full access and every Auto call is reviewed because a plugin may act outside
Rig's filesystem sandbox. Cancellation reaches the handler's `AbortSignal`; disconnected,
replaced, restarted, and uninstalled plugin generations are retired immediately.

`createHappyMcpToolName(pluginName, serverName, toolName)` returns that exact stable agent-facing
name for tests, diagnostics, or documentation.

The handle returned by `happy.mcp.startServer()` reports `status` as `connected`, `reconnecting`,
or `closed`, exposes the most recent reconnect `failure`, and has a `registrationId` that changes
after successful re-registration. An unexpected event-stream end aborts active calls and
re-registers with bounded exponential backoff; `close()` stops that recovery permanently.

## Runtime schemas

The public value types are derived from exported TypeBox schemas. Plugins may reuse the same
schemas when validating persisted state, configuration, or test fixtures:

```ts
import { Value } from "@sinclair/typebox/value";
import { createWorkspaceInputSchema } from "happy-plugins";

const input: unknown = JSON.parse(serializedInput);
const workspaceInput = Value.Decode(createWorkspaceInputSchema, input);
```

The primary schema exports are:

- `happyProjectSchema`, `happyWorkspaceSchema`, `happyWorkspaceStatusSchema`, and `happySessionSchema`
- `listWorkspacesInputSchema`
- `createWorkspaceInputSchema`, `renameWorkspaceInputSchema`, and `archiveWorkspaceInputSchema`
- `createSessionInputSchema`
- `sendAgentMessageInputSchema` and `agentMessageDeliverySchema`
- `happyMcpServerRegistrationSchema`, `happyMcpEventSchema`,
  `happyMcpCallCompletionSchema`, and `happyMcpToolResultSchema`
- `happyPluginAppContributionSchema`, `happyPluginAppResourceSummarySchema`, and
  `happyPluginAppToolSummarySchema`
- `happyProviderUsageEntrySchema`, `happyProviderUsageSchema`,
  `happyProviderUsageWindowSchema`, and `happyProviderUsageCreditsSchema`
- `happyPluginTestSeedSchema` and `happyPluginTestRequestSchema`

Request-body and response-envelope schemas are also exported for test harnesses implementing the
same boundary.

## Errors

The SDK rejects invalid inputs before sending them. It also validates every successful daemon
response against its TypeBox schema.

When Happy rejects a valid request, the SDK throws `HappyPluginApiError`:

```ts
import { HappyPluginApiError, happy } from "happy-plugins";

try {
    await happy.workspaces.archive({
        projectId: "missing-project",
        workspaceId: "missing-workspace",
        version: 0,
    });
} catch (error) {
    if (error instanceof HappyPluginApiError) {
        console.error(`Happy returned HTTP ${error.status}: ${error.message}`);
    }
    throw error;
}
```

## Testing outside Happy

Normal plugins should import the singleton `happy`. Tests and custom harnesses may construct a
client explicitly:

```ts
import { createHappyPluginClient } from "happy-plugins";

const client = createHappyPluginClient({
    socketPath: "/path/to/test.sock",
    token: "test-token",
});
```

The explicit client uses the same API and runtime validation as `happy`.

## Distribution checklist

Distribute the plugin folder, excluding the generated `.build/` folder and local `node_modules/`.
Before sharing it:

1. Install the current `happy-plugins` package for local type checking.
2. Keep the manifest paths relative and inside the plugin folder.
3. Include the TypeScript sources and required PNG icon.
4. Start it with the oldest Happy version you intend to support; the daemon build is the compatibility
   test.
5. Check `.build/plugin.log` for startup or runtime errors.

The SDK package is MIT licensed. Plugins choose their own license.
