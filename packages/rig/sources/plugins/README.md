# Plugins

This module owns locally installed Rig plugins: finding them, validating their manifests and icons,
compiling their TypeScript against Rig's SDK, running each plugin in the existing command sandbox,
and serving the private API socket it uses.

A plugin lives in two places. Its code and everything Rig generates for it stay in Rig's managed
home, out of the way. Everything the plugin writes while it runs goes to a folder a person can open.

```text
~/.happy/rig/plugins/<folder>             installed plugin, managed by Rig
  |
  +-- happy.plugin.json
  +-- icon.png
  +-- index.ts
  +-- .build/
       +-- build/                         TypeScript output
       +-- node_modules/happy-plugins/    SDK shipped by this Rig
       +-- plugin.log                     bounded current-run output

~/Happy/Plugins/<folder>                  the plugin's writable folder
  |                                       (Linux: ~/happy/plugins/<folder>)
  +-- .runtime/plugin.sock                per-plugin API socket
  +-- whatever the plugin keeps
```

The plugin process runs with its writable folder as the working directory and receives that path as
`HAPPY_PLUGIN_DIRECTORY`. The socket sits there too, because the sandbox that confines the plugin
allows writes only inside that folder.

The authenticated socket also resolves workspace IDs to daemon-owned paths for trusted, one-shot
Bash commands and bounded file reads and writes. Commands always run non-interactively with a
timeout (30 seconds by default, at most 5 minutes), retain at most 1 MiB from each output stream,
and report each stream's truncation independently. Workspace files are limited to 1 MiB; paths
must be relative, and Rig's canonical workspace-boundary check rejects traversal and symlink
escapes. Exec and file routes use `/workspaces/:workspaceId/...` because these operations need only
the SDK's globally unique workspace ID; project-scoped create, rename, and archive routes keep
their project context. Workspace exec runs as a daemon-side child process outside the plugin's own
process sandbox. This is intentional under Rig's plugin trust model.

`PluginManager` is the daemon lifecycle boundary. Registration and compilation are separate
functions so a bad plugin can be reported without preventing other plugins or the daemon
from starting.

Registration is immediate. `install` copies a folder in, compiles it, and starts the plugin before
it returns; `uninstall` stops the plugin before removing its code and always keeps the folder the
plugin writes to. Every change — including a plugin that exits on its own — publishes a live
`plugins_changed` event carrying the whole current set, so clients never poll and never wait for a
restart. A plugin is staged in a hidden folder and compiled there, so a plugin that fails to build
is never installed and never replaces a working one.

Manifest versions use Semantic Versioning and default to `0.0.0` when omitted. Installing over an
existing folder is classified as an upgrade, downgrade, or reinstall by comparing versions; the
install result and its final `plugins_changed` event carry that classification. Reading the old
version is best-effort so a damaged installation can still be repaired; when it cannot be read,
the replacement is classified as a reinstall.

`PluginMcpRegistry` is a daemon-wide `McpToolProvider`. Each plugin process generation owns a
connection to it through the already-authenticated plugin socket. An SDK registration becomes live
only when its NDJSON call stream attaches; exit, disconnect, replacement, restart, or uninstall
retires that generation and rejects pending calls before stale completions can land. Sessions load
this provider through the same composite MCP path as configured servers, so provider tool assembly
and `AgentContext`/`PermissionContext` behavior stay shared.

`PluginAppRegistry` owns bounded manifest-declared static bundles, app-scoped MCP calls, and
plugin-private JSON storage. Static contributions become visible as soon as the plugin process
starts, including apps with no tools. The catalog is republished when an MCP stream later attaches,
so app-visible tools appear without hiding or remounting the static app. Stable identity combines
the plugin folder and authored app ID; generation is unique to the process. Resource and tool
routes require both, so replacement, exit, disconnect, restart, or uninstall retires stale views.
Resource, bundle, registration-body, tool-call body, storage, and concurrent-call limits keep
memory and work bounded.

The build snapshots at most 8 apps, 64 resources per app, 256 KiB per resource, and 1 MiB per app.
It ignores hidden authoring debris, validates every published path and contribution against the
public TypeBox schemas, and rejects symlinks, traversal, unsupported media, and incomplete pages or
icons. Plugin-private storage is JSON-only and bounded to 1,024 safe keys, 64 KiB per value, and
5 MiB total. Atomic-write leftovers are removed on the next storage operation.

The `/plugins` snapshot and `plugins_changed` events carry the same ordered catalog version in
addition to the global cursor. The manager assigns it synchronously when state changes and retries
an asynchronous folder read if the version moves underneath it. `rig-connect` can therefore settle
both directions of the stream-before-snapshot race without using arrival order. Installation
metadata on an event is best-effort: if another catalog change supersedes that event before it is
published, the newer whole-catalog event may omit the installation result.

The manager records one authoritative state for every registered plugin: `running`, `stopped`, or
`build_failed`. The current-run file retains the most recent 1 MiB and resets for each process
generation. `readLog` returns its newest 16 KiB, or the newest 16 KiB of the build diagnostic, and
marks the snapshot when that read bound omitted older output. The daemon protocol serves these
through `GET /plugins` and `GET /plugins/<name>/log`; `/plugins`, the `plugin_logs` agent tool, and
`rig-connect` consume that boundary without polling.

## GitHub repository catalogs

A GitHub repository can publish plugins by placing `happy-plugins.json` at its root. The index is
an object with one `plugins` array. Every entry names the plugin's folder, gives its human-facing
display name and description, declares an exact Semantic Version, and points to the plugin
subdirectory inside the repository. That subdirectory contains `happy.plugin.json`, `icon.png`,
and the plugin's code.

```json
{
    "plugins": [
        {
            "name": "clock",
            "displayName": "Clock",
            "description": "Shows the current time to agents.",
            "version": "1.2.0",
            "path": "plugins/clock"
        },
        {
            "name": "github-watch",
            "displayName": "GitHub Watch",
            "description": "Reports repository checks and failures.",
            "version": "0.4.1",
            "path": "plugins/github-watch"
        }
    ]
}
```

Rig validates the complete index before returning any catalog entries. Repository names use
`owner/repo` form, and callers may select a branch, tag, or commit; omitting the ref uses the
repository's default branch. Discovery reads at most 1 MiB and times out after 10 seconds.
Installation downloads a bounded GitHub tarball, extracts only the indexed subdirectory into a
temporary staging folder, and then uses the same local installation path as every other plugin.
