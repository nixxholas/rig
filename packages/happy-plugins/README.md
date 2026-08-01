# happy-plugins

`happy-plugins` is the public TypeScript SDK for writing local Rig extensions.

An extension imports one ready-to-use client:

```ts
import { rig } from "happy-plugins";

const projects = await rig.projects.list();
console.log(`Rig has ${projects.length} projects.`);
```

Rig supplies the connection automatically when it starts the extension. Extension code does not
open a daemon connection, find credentials, or depend on Rig's internal protocol.

## Status

The SDK is an early preview. The current surface covers projects, workspaces, sessions, and messages
to agents. MCP and embedded UI extension points are planned but are not part of this package yet.

## How authoring and runtime versions work

Install the published package while authoring for editor completion and local type checking:

```sh
pnpm add --save-dev happy-plugins typescript@^7.0.2 @types/node
```

This installation is an authoring dependency. At runtime, Rig compiles the extension with
TypeScript 7 and substitutes the copy of `happy-plugins` shipped with that Rig installation. The
daemon's build is the final compatibility check. An extension cannot accidentally run against a
different SDK from the one its daemon implements.

Rig itself does not require an extension to have a `package.json` or its own SDK installation. A
TypeScript entry file, manifest, and PNG icon are enough.

## Create an extension

Create one folder per extension:

```text
macOS: ~/Happy/Extensions/project-counter/
Linux: ~/happy/extensions/project-counter/

project-counter/
├── rig.plugin.json
├── icon.png
└── index.ts
```

The installation root can be overridden with the absolute `RIG_EXTENSIONS_DIRECTORY` environment
variable.

### `rig.plugin.json`

The manifest is intentionally small and exact:

```json
{
    "name": "Project Counter",
    "description": "Reports how many projects Rig knows about.",
    "entry": "index.ts",
    "icon": "icon.png"
}
```

All four fields are required. Extra fields are rejected.

- `name`: a non-empty human-readable name.
- `description`: a non-empty explanation of the extension.
- `entry`: a relative path to a `.ts` file inside the extension folder.
- `icon`: a relative path to a PNG file inside the extension folder.

Entry and icon paths must remain inside the extension folder. The entry and icon themselves must be
ordinary files rather than symbolic links. Rig does not register an extension whose manifest or
icon is invalid.

### `index.ts`

```ts
import { rig } from "happy-plugins";

const sessions = await rig.sessions.list();

console.log(`The extension can see ${sessions.length} sessions.`);

// Keep a service-style extension alive until Rig shuts it down.
await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
});
```

The entry is an ES module and may use top-level `await`. Relative TypeScript imports are supported.
Rig starts the compiled entry with the extension folder as its working directory.

Restart the Rig daemon after adding or changing an extension. Rig discovers installed folders,
validates their manifests, compiles their TypeScript, and starts each valid extension.

## Runtime model

Each extension runs in its own process under Rig's existing command sandbox. The extension may
write state inside its own folder.

Rig injects these environment variables:

| Variable                 | Meaning                                           |
| ------------------------ | ------------------------------------------------- |
| `RIG_PLUGIN_DIRECTORY`   | Absolute path to the extension's writable folder. |
| `RIG_PLUGIN_SOCKET_PATH` | Private Unix socket used by the SDK.              |
| `RIG_PLUGIN_TOKEN`       | Per-process bearer token used by the SDK.         |

Normal extension code should use the exported `rig` client and does not need to read the socket or
token directly.

Rig captures stdout and stderr for the current run in `.rig/extension.log` inside the extension
folder. The log is bounded to 1 MiB. Files below `.rig/` are generated runtime state and should not
be edited or distributed.

## API

```ts
import { rig } from "happy-plugins";
```

All methods return promises. Inputs and daemon responses are validated with TypeBox at runtime.

### Projects

```ts
const projects = await rig.projects.list();
```

Signature:

```ts
rig.projects.list(): Promise<readonly RigProject[]>
```

`RigProject` contains:

```ts
type RigProject = {
    id: string;
    name: string;
    path: string;
    archivedAt?: number;
};
```

### Workspaces

List every workspace, or only workspaces belonging to one project:

```ts
const all = await rig.workspaces.list();
const projectWorkspaces = await rig.workspaces.list({ projectId: "project-id" });
```

Create a managed workspace:

```ts
const workspace = await rig.workspaces.create({
    projectId: "project-id",
    name: "Investigate parser",
    // baseRef: "main",
});
```

Rename or archive a workspace using its current version:

```ts
const renamed = await rig.workspaces.rename({
    projectId: workspace.projectId,
    workspaceId: workspace.id,
    name: "Fix parser",
    version: workspace.version,
});

await rig.workspaces.archive({
    projectId: renamed.projectId,
    workspaceId: renamed.id,
    version: renamed.version,
});
```

Signatures:

```ts
rig.workspaces.list(input?: {
    projectId?: string;
}): Promise<readonly RigWorkspace[]>

rig.workspaces.create(input: {
    projectId: string;
    name: string;
    baseRef?: string;
}): Promise<RigWorkspace>

rig.workspaces.rename(input: {
    projectId: string;
    workspaceId: string;
    name: string;
    version: number;
}): Promise<RigWorkspace>

rig.workspaces.archive(input: {
    projectId: string;
    workspaceId: string;
    version: number;
}): Promise<RigWorkspace>
```

Workspace mutations use optimistic versions. Pass the `version` from the most recently returned
workspace.

`RigWorkspace` contains:

```ts
type RigWorkspace = {
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
const sessions = await rig.sessions.list();

const session = await rig.sessions.create({
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
rig.sessions.list(): Promise<readonly RigSession[]>

rig.sessions.create(input: {
    cwd: string;
    providerId?: string;
    modelId?: string;
    effort?: string;
    appendSystemPrompt?: string;
    workspaceId?: string;
}): Promise<RigSession>
```

`RigSession` contains:

```ts
type RigSession = {
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

Use the stable `agentId` returned by `rig.sessions.list()` or `rig.sessions.create()`:

```ts
const [session] = await rig.sessions.list();

if (session !== undefined) {
    const delivery = await rig.agents.sendMessage({
        agentId: session.agentId,
        message: "The extension finished indexing the project.",
    });

    console.log(`Delivered to session ${delivery.sessionId}.`);
}
```

Signature:

```ts
rig.agents.sendMessage(input: {
    agentId: string;
    message: string;
}): Promise<{
    delivered: true;
    runId: string;
    sessionId: string;
}>
```

## Runtime schemas

The public value types are derived from exported TypeBox schemas. Extensions may reuse the same
schemas when validating persisted state, configuration, or test fixtures:

```ts
import { Value } from "@sinclair/typebox/value";
import { createWorkspaceInputSchema } from "happy-plugins";

const input: unknown = JSON.parse(serializedInput);
const workspaceInput = Value.Decode(createWorkspaceInputSchema, input);
```

The primary schema exports are:

- `rigProjectSchema`, `rigWorkspaceSchema`, `rigWorkspaceStatusSchema`, and `rigSessionSchema`
- `listWorkspacesInputSchema`
- `createWorkspaceInputSchema`, `renameWorkspaceInputSchema`, and `archiveWorkspaceInputSchema`
- `createSessionInputSchema`
- `sendAgentMessageInputSchema` and `agentMessageDeliverySchema`

Request-body and response-envelope schemas are also exported for test harnesses implementing the
same boundary.

## Errors

The SDK rejects invalid inputs before sending them. It also validates every successful daemon
response against its TypeBox schema.

When Rig rejects a valid request, the SDK throws `RigPluginApiError`:

```ts
import { RigPluginApiError, rig } from "happy-plugins";

try {
    await rig.workspaces.archive({
        projectId: "missing-project",
        workspaceId: "missing-workspace",
        version: 0,
    });
} catch (error) {
    if (error instanceof RigPluginApiError) {
        console.error(`Rig returned HTTP ${error.status}: ${error.message}`);
    }
    throw error;
}
```

## Testing outside Rig

Normal extensions should import the singleton `rig`. Tests and custom harnesses may construct a
client explicitly:

```ts
import { createRigPluginClient } from "happy-plugins";

const client = createRigPluginClient({
    socketPath: "/path/to/test.sock",
    token: "test-token",
});
```

The explicit client uses the same API and runtime validation as `rig`.

## Distribution checklist

Distribute the extension folder, excluding generated `.rig/` contents and local `node_modules/`.
Before sharing it:

1. Install the current `happy-plugins` package for local type checking.
2. Keep the manifest paths relative and inside the extension folder.
3. Include the TypeScript sources and required PNG icon.
4. Start it with the oldest Rig version you intend to support; the daemon build is the compatibility
   test.
5. Check `.rig/extension.log` for startup or runtime errors.

The SDK package is MIT licensed. Extensions choose their own license.
