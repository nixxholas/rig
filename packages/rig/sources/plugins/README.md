# Plugins

This module owns locally installed Rig plugins: finding them, validating their manifests, icons,
and declared entry points, running each plugin in the existing command sandbox, and serving the
private API socket it uses. Plugins arrive ready to run; Rig never compiles or rewrites them.

A plugin lives in two places. Its code and everything Rig generates for it stay in Rig's managed
home, out of the way. Everything the plugin writes while it runs goes to a folder a person can open.

```text
~/.happy/rig/plugins/<folder>             installed plugin, managed by Rig
  |
  +-- happy.plugin.json
  +-- icon.png
  +-- index.ts                            optional for a skills-only plugin
  +-- skills/                             conventional skill root
  |    +-- release-check/
  |         +-- SKILL.md
  +-- plugin.log                          bounded current-run output

~/Happy/Plugins/<folder>                  the plugin's writable folder
  |                                       (Linux: ~/happy/plugins/<folder>)
  +-- .runtime/plugin.sock                per-plugin API socket
  +-- whatever the plugin keeps
```

The manifest's `main` field names a JavaScript or TypeScript file inside the installed folder. It is
required unless the plugin provides a skills directory. Rig launches it with `process.execPath`,
the same Node executable that is running Rig. The supported Node runtime strips erasable TypeScript
syntax natively, so `.ts`, `.mts`, and `.cts` entry points need no compiler or loader flag.
TypeScript constructs that require JavaScript generation rather than type stripping are not
supported. JavaScript entry points run according to normal Node module rules; use `.mjs` or a local
`"type": "module"` package declaration for ESM.

Rig ships the built `happy-plugins` SDK under its own `plugin-sdk` distribution folder. Startup
passes one `--import` module to Node. That module registers a synchronous ESM resolution hook which
maps the exact `happy-plugins` and `happy-plugins/internal` specifiers to Rig's shipped files.
Nothing is copied into the plugin and the plugin does not need to vendor the SDK. This loader hook
is the only SDK-resolution mechanism; `NODE_PATH` is not used because it does not resolve ESM
imports.

Rig provides only `happy-plugins` at runtime. A plugin must bundle every other third-party
dependency into its own installed files; `node_modules` is never copied during installation.

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

The socket exposes the same persistent slot store used by Happy's HTTP routes and agent tools.
Plugin-created entries carry a typed plugin author containing the stable installed folder and
human-readable plugin name. Uninstall removes every slot entry authored by that plugin, because
the author and the code responsible for maintaining the entry are gone.

## Managed network interception

A process plugin may declare up to 16 exact hostnames in the manifest's `interceptDomains` array.
Wildcards are deliberately unsupported. These declarations are selectors, never permissions:
they do not add a domain or port to the project/global managed-network allowlist. The proxy checks
the sandbox policy first, and a blocked destination is rejected without contacting any plugin.
A plugin rewrite is checked against the same policy again before Rig opens the rewritten
destination.

For allowed plain-HTTP traffic, the proxy buffers at most 256 KiB of request body and sends the
method, URL, headers, and bytes through the authenticated plugin socket. A handler has five seconds
to pass through, return a complete synthetic response, or replace request fields before normal
forwarding. Response bodies and replacement request bodies have the same 256 KiB bound. An
oversized body, a request body that does not finish within five seconds, a handler timeout,
disconnect, malformed result, or any other plugin failure is logged against the owning plugin and
fails open to the ordinary proxy path. Requests without a matching live listener stay on the
streaming proxy path and are never buffered for interception.

Socket events are validated and capped at 512 KiB before they are written. Header metadata is
clamped to a 64 KiB aggregate budget, and a backpressured plugin stream receives no more events
until it drains, so optional observation cannot create an unbounded daemon buffer.

When several running plugins declare the same hostname, folder-name order decides ownership:
the lexicographically first plugin may handle the request and the rest receive events marked
`mode: "observe"` only.

HTTPS remains an opaque CONNECT tunnel. Rig does not mint certificates and does not unwrap TLS;
full HTTPS MITM is out of scope. A plugin can observe only the declared hostname, port, and the
client/server byte counts reported when an allowed tunnel closes. Every matching plugin receives
that fire-and-forget observation. SOCKS traffic is unchanged and is not intercepted.

Plugins may also publish a file to the shared generated-media store, either from bounded bytes or
from a relative path inside their own writable folder. Both forms are capped at 10 MiB. Path reads
resolve canonically and reject traversal and symbolic-link escapes. The result is a
`generated/<name>` locator served by the existing authenticated generated-media route; it does not
create a session attachment because attachment delivery is owned by an agent turn.

`PluginManager` is the daemon lifecycle boundary. Registration validates each manifest, PNG icon,
and `main` file so a bad plugin can be reported without preventing other plugins or the daemon from
starting.

Registration is synchronous in the product sense. Every process generation moves through one
explicit `starting -> running | failed` state machine. It has one 10-second window to register its
MCP server and managed-network listeners, attach their NDJSON streams, then call
`happy.ready("Ready.")`. Registration must finish before readiness is reported. A generation that
misses the window becomes failed with the reason
`The plugin did not report ready within 10 seconds.`, its process is killed, and its startup state
cannot transition again. Late registration and stream attachment are rejected for that generation.
Skills-only plugins have no process contribution to declare and become running immediately.
The readiness call also declares the plugin-authored status string; `happy.status.set(...)` may
update it after startup. Rapid status writes are coalesced into bounded catalog publications.

Daemon startup launches every discovered plugin concurrently and resolves the manager's `start`
only after every plugin is running or failed. Installing and replacing a plugin use the same
bounded startup path before returning. `uninstall` stops the plugin before removing its code and
always keeps the folder the plugin writes to. Every completed change — including a plugin that
exits on its own — publishes a live `plugins_changed` event carrying the whole current set, so
clients never poll and never wait for a restart. A plugin is validated in a hidden staging folder,
so an invalid replacement is never installed and never displaces a working one.

Manifest versions use Semantic Versioning and default to `0.0.0` when omitted. Installing over an
existing folder is classified as an upgrade, downgrade, or reinstall by comparing versions; the
install result and its final `plugins_changed` event carry that classification. Reading the old
version is best-effort so a damaged installation can still be repaired; when it cannot be read,
the replacement is classified as a reinstall.

A manifest may set `"skills": "some/folder/"` relative to the plugin folder. When the field is
omitted, Rig uses `skills/` if that directory exists. Each subfolder containing a `SKILL.md` is
loaded through the general filesystem skill catalog and identifies the plugin that supplied it.
Only plugins in the manager's `running` state contribute skills; stopped and failed plugins do not.
A plugin with an icon and skills may omit `main` entirely. Rig activates that static contribution
without spawning a plugin process.

A manifest may also contribute a bounded static system prompt with either
`"systemPrompt": { "text": "..." }` or `"systemPrompt": { "path": "SYSTEM_PROMPT.md" }`.
Prompt-only plugins do not need a process. Active contributions are appended in plugin folder name
order and capped at 256 KiB in total.

`PluginHookRegistry` owns process-generation-scoped prompt middleware and tracing subscriptions.
`happy.hooks.onSystemPrompt` uses an authenticated NDJSON call stream: each hook sees the prior
plugin's replacement, receives the composed system prompt plus current user prompt, and has a
two-second deadline inside a five-second aggregate chain budget. Oversized, timed-out,
disconnected, failed, or over-budget calls are logged and skipped.
`happy.tracing.subscribe` uses the same NDJSON stream style for observation-only turn, inference,
and tool lifecycle events. Each plugin has a 128-event drop-oldest queue; socket backpressure never
reaches the agent run, and logged drop counts make slow subscribers visible. System-prompt hook
registration and stream attachment are required startup contributions, so losing that stream after
readiness retires the plugin generation under the same live-process-failure versus clean-exit rules
as MCP. Tracing subscriptions remain dynamic before and after readiness; their stream generations
recover with bounded backoff and cannot attach after the plugin generation has failed. Synthetic
tool results for calls interrupted before execution are durable loop events but do not produce
tracing lifecycle events, so every traced tool finish has a matching start.

`PluginMcpRegistry` is a daemon-wide `McpToolProvider`. Each plugin process generation owns a
connection to it through the already-authenticated plugin socket. An SDK registration becomes live
only when its NDJSON call stream attaches during startup. Reporting ready closes registration for
that generation. Exit, disconnect, replacement, restart, or uninstall retires the generation and
rejects pending calls before stale completions can land. Sessions load this provider through the
same composite MCP path as configured servers, so provider tool assembly and
`AgentContext`/`PermissionContext` behavior stay shared. If an attached MCP stream closes after
readiness, the generation becomes failed and stops; it cannot remain running without the tools it
declared at startup. That retirement publishes the changed plugin catalog immediately.

`PluginAppRegistry` owns bounded manifest-declared static bundles, app-scoped MCP calls, and
plugin-private JSON storage. Static bundles and their startup-attached tools are published together
when the plugin reports ready, including apps with no tools. Stable identity combines the plugin
folder and authored app ID; generation is unique to the process. Resource and tool routes require
both, so replacement, exit, disconnect, restart, or uninstall retires stale views.
Resource, bundle, registration-body, tool-call body, storage, and concurrent-call limits keep
memory and work bounded.

Startup snapshots at most 8 apps, 64 resources per app, 256 KiB per resource, and 1 MiB per app. It
ignores hidden authoring debris, validates every published path and contribution against the public
TypeBox schemas, and rejects symlinks, traversal, unsupported media, and incomplete pages or icons.
Plugin-private storage is JSON-only and bounded to 1,024 safe keys, 64 KiB per value, and 5 MiB
total. Atomic-write leftovers are removed on the next storage operation.

The `/plugins` snapshot and `plugins_changed` events carry the same ordered catalog version in
addition to the global cursor. The manager assigns it synchronously when state changes and retries
an asynchronous folder read if the version moves underneath it. `rig-connect` can therefore settle
both directions of the stream-before-snapshot race without using arrival order. Installation
metadata on an event is best-effort: if another catalog change supersedes that event before it is
published, the newer whole-catalog event may omit the installation result.

The manager records one authoritative state for every registered plugin: `running`, `stopped`, or
`failed`. The current-run file retains the most recent 1 MiB and resets for each process
generation. `readLog` returns its newest 16 KiB, or the bounded startup diagnostic when no process
started, and marks the snapshot when that read bound omitted older output. The daemon protocol
serves these through `GET /plugins` and `GET /plugins/<name>/log`; `/plugins`, the `plugin_logs`
agent tool, and `rig-connect` consume that boundary without polling.

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
temporary staging folder, and then uses the same copy-and-validate installation path as every other
plugin.
