# happy-plugins

`happy-plugins` is the public TypeScript SDK for writing local Happy plugins.

An plugin imports one ready-to-use client:

```ts
import { happy } from "happy-plugins";

const projects = await happy.projects.list();
console.log(`Happy has ${projects.length} projects.`);
```

Happy supplies the connection automatically when it starts the plugin. Plugin code does not
open a daemon connection, find credentials, or depend on Happy's internal protocol.

## Status

The SDK is an early preview. The current surface covers projects, workspaces, sessions, and messages
to agents. MCP and embedded UI plugin points are planned but are not part of this package yet.

## How authoring and runtime versions work

Install the published package while authoring for editor completion and local type checking:

```sh
pnpm add --save-dev happy-plugins typescript@^7.0.2 @types/node
```

This installation is an authoring dependency. At runtime, Happy compiles the plugin with
TypeScript 7 and substitutes the copy of `happy-plugins` shipped with that Happy installation. The
daemon's build is the final compatibility check. An plugin cannot accidentally run against a
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
    "entry": "index.ts",
    "icon": "icon.png"
}
```

All four fields are required. Extra fields are rejected.

- `name`: a non-empty human-readable name.
- `description`: a non-empty explanation of the plugin.
- `entry`: a relative path to a `.ts` file inside the plugin folder.
- `icon`: a relative path to a PNG file inside the plugin folder.

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

Restart the Happy daemon after adding or changing a plugin. Happy discovers installed folders,
validates their manifests, compiles their TypeScript, and starts each valid plugin.

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
plugin folder. The log is bounded to 1 MiB. Generated runtime state below `.build/` and `.runtime/`
should not be edited or distributed.

## API

```ts
import { happy } from "happy-plugins";
```

All methods return promises. Inputs and daemon responses are validated with TypeBox at runtime.

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
