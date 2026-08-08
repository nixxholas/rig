# Worklets

A worklet is background compute Rig keeps running: TypeScript imported as a source folder,
versioned like an applet, writing only into its own `Data` folder, and declaring tools any agent
can call. Worklets are global, not per-project. See
[`master-plans/17-worklets.md`](../../../../master-plans/17-worklets.md) for where they are going.

This module owns the installed worklets and the processes that run them. `WorkletStore` owns the
catalog rows and the folders. `WorkletManager` owns the processes and is the only thing that knows
whether a worklet is up. `WorkletToolRegistry` is the daemon-wide catalog of tools running worklets
have declared, and it is an `McpToolProvider`, so a worklet's tools reach a model the same way an
MCP server's do.

## Layout

Everything about one worklet lives in one folder a person can open. The versions come and go above
the data; the data is the durable half.

```text
~/Happy/Worklets/<name>/                  (Linux: ~/happy/worklets/<name>/)
  |
  +-- favicon.png                         the 512x512 icon, as an applet has
  +-- favicon.ico                         squircle-masked, for hosts that want it
  +-- worklet.log                         bounded current-run output
  +-- Data/                               the worklet's own writable folder
  |    +-- whatever the worklet keeps     and nothing else
  +-- v1/                                 an import, never written again
  |    +-- worklet.json                   the manifest this version was imported with
  |    +-- README.md                      what it does, for a person
  |    +-- DEVELOPMENT.md                 how it works, for whoever changes it
  |    +-- index.ts
  +-- v2/

~/.happy/rig/worklets/<name>/             Rig's own runtime folder, mode 0700
  |
  +-- worklet.sock                        the socket Rig reaches this worklet on
```

The socket is Rig's bookkeeping rather than the worklet's output, so it lives in Rig's managed home
and the worklet's `Data` folder holds only what the worklet itself wrote. The runtime folder is
removed when the worklet is uninstalled; the data folder is not.

Installing imports a source folder as `v1`. Updating imports the next version and restarts on it.
Reverting moves the current-version pointer and restarts; nothing is deleted. Uninstalling removes
every version and keeps `Data`, because the data outlives the code that wrote it — a reinstall
finds its old state waiting.

## The manifest

A worklet folder must have a `worklet.json` at its root:

```json
{
    "name": "github-watch",
    "description": "Watches a repository and reports what landed.",
    "permissions": {
        "disk": "none",
        "network": { "hosts": ["api.github.com"] }
    }
}
```

The manifest, not the caller, decides what a worklet is and what it may do. `worklet_install` takes
only a folder and an icon, so nothing can install code under a description or a permission set
other than the one the code itself declares.

`description` is a label rather than an explanation: one line, capped, shown beside the worklet's
name in a list. Anything longer belongs in the worklet's `README.md`.

`permissions` is required, and every field of it is. A worklet that wants nothing beyond its own
`Data` folder still writes `"none"` twice, because silence is not a grant.

- `disk` is always `"none"`. The worklet's `Data` folder is writable and is never named here;
  every other filesystem location, including its own installed source, remains read-only.
- `network` is `"none"` or `{ "hosts": [...] }`. A host may carry a port and may lead with `*.`
  for subdomains; port 443 is assumed when none is given. Scoped traffic goes through Rig's
  managed network proxy, which allows exactly those hosts and refuses the rest. `"none"` means
  the sandbox has no egress at all. Worklets cannot bind host ports or accept inbound traffic.

Permissions belong to the version that declared them, so reverting restores the older manifest
along with the older code and never leaves a newer grant in force. An update whose manifest names a
different worklet is refused rather than quietly taking over this one's data.

## The two documents

Every worklet folder must also carry a `README.md` and a `DEVELOPMENT.md` at its root, and both
must have something written in them. A worklet runs unattended for as long as it is installed, so
the person who finds it later is rarely the one who wrote it:

- **`README.md`** says in plain language what the worklet does and why someone would run it. No
  jargon, no internals — the person reading it wants to know whether to keep it.
- **`DEVELOPMENT.md`** says how it works inside: what it polls, what it keeps in `Data`, which
  tools it declares, what breaks it. It is for whoever changes it next.

They are ordinary files in the imported tree, so each version keeps the documents it was imported
with, and reverting brings the matching pair back with the code. Rig refuses a folder that is
missing either one or that fills it with a placeholder.

## Running a worklet

Besides its manifest and its two documents, a worklet is a folder with `index.ts`, `index.js`, or
`index.mjs` at its root. Rig bundles that entry while the source is still staged, before the
version becomes current, so syntax and missing imports fail the install or update without stopping
the healthy version already running. Rig launches the built output with `process.execPath`, the
same Node executable running Rig, and loads it through the same Jiti runtime Pi uses for
extensions. The runtime maps the exact `happy-worklets` specifier to the SDK this Rig ships, so a
worklet never vendors the SDK and always runs against the version its host understands. Every
other third-party dependency must be included in the imported source tree; `node_modules` is never
copied.

The process is sandboxed in `workspace_write` mode with its `Data` folder as its working directory
and, by default, the only place it may write. Anything beyond that — other writable paths, or any
network at all — comes from the permissions its own manifest declared. It receives `HAPPY_WORKLET_DATA_DIRECTORY`,
`HAPPY_WORKLET_NAME`, `HAPPY_WORKLET_SOCKET_PATH`, and `HAPPY_WORKLET_TOKEN`, so a worklet never
finds credentials or paths for itself. Its stdout and stderr go to a bounded `worklet.log`.

A sandboxed command can otherwise only reach a socket it created inside its own workspace, so the
worklet's socket is granted to the sandbox explicitly, by exact path, through
`createSandboxedCommand`'s `unixSocketPaths`. The grant allows connecting to that one socket and
nothing more: not binding there, not the folder around it, and never a path Rig protects. A
neighbouring socket in the same folder stays unreachable.

A Unix socket address is a small fixed-size kernel field, so the socket path has a hard length
limit. A worklet whose runtime folder is too deeply nested is refused with that reason rather than
an opaque `EINVAL` at bind time.

## Startup and tools

A worklet declares its tools once and then reports ready, within a bounded startup window:

```ts
import { defineWorkletTool, Type, worklet } from "happy-worklets";

await worklet.tools([
    defineWorkletTool({
        description: "Lists new commits.",
        inputSchema: Type.Object({ repository: Type.String() }),
        name: "commits",
        execute: async ({ repository }) => ({
            content: [{ text: await read(repository), type: "text" }],
        }),
    }),
]);
await worklet.ready("Watching one repository.");
```

A registration becomes callable only once the worklet attaches its call stream, so a model never
sees a tool nothing is listening for. Retiring a worklet rejects its pending calls synchronously,
so a result from a stopped generation can never land after a restart. Tool names are qualified by
the worklet that owns them: `worklet_<name>_<tool>`, with dashes in the worklet's name replaced by
underscores.

Worklet tools require Auto or Full access, because a worklet runs its own code outside Rig's
per-command sandbox, and every call is reviewed.

## Reaching worklets

Everything about worklets is reachable three ways, and all three go through `WorkletManager`:

- **The API.** `/worklets` and `/worklets/<name>`, with `versions`, `revert`, `log`, and the icon
  beneath it. Every change publishes the whole current set as a live `worklets_changed` event
  carrying a version, so a client reconciles a snapshot against a live event without polling.
- **Tools.** The common tools in [`../tools/worklets`](../tools/worklets), available to every model.
- **`rig-connect`.** `connectWorklets` follows the catalog and drives the same management calls.

## Sleep

`asleep` exists in the protocol and nothing enters it yet: today a worklet simply runs. The plan is
that a worklet with nothing outstanding — no timer, no declared endpoint, no event subscription, no
call in flight — is parked and costs nothing until one of those wakes it.
