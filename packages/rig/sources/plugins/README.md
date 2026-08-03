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

## Docker runtime

A root `Dockerfile` makes a process plugin run inside Docker. Rig builds it during installation and
tags the image as `rig-plugin-<folder>:<content-hash>`. An already-present tag is reused, so
installing unchanged contents does not rebuild the image. The Docker build stream is retained in
the same bounded `plugin.log` as the plugin's stdout and stderr. A manifest may explicitly confirm
the Dockerfile with `"docker": true`, or run from a prebuilt image without a Dockerfile with
`"docker": { "image": "registry.example.com/plugin:1.0.0" }`. Rig pulls a declared image during
installation only when it is absent locally. Build and pull failures reject the staged installation
before it replaces any working version.

The image supplies the plugin's Node executable. Rig does not inject its own Node, so the image must
provide a Node release compatible with this Rig's native TypeScript stripping and synchronous
module-loader hooks. Rig starts `node --import <loader> <main>` inside the image. Plugin code is
mounted read-only at `/plugin`; the built `happy-plugins` SDK and loader are separate read-only
mounts. The user-visible writable folder is mounted read-write at `/plugin-data`, becomes the
working directory, and receives `HAPPY_PLUGIN_DIRECTORY=/plugin-data`.

The authenticated host API socket remains in `.runtime/plugin.sock` beneath that writable folder.
Native Linux Docker connects to it through the bind mount as
`/plugin-data/.runtime/plugin.sock`. Docker Desktop exposes a host-created socket in the mount but
does not reliably let Linux connect to it (`ENOTSUP`), so macOS uses the same pattern as Rig's
Docker proxy sockets: a short-lived loopback relay reaches the host socket, while a Rig-supplied
Node bootstrap exposes a container-native socket at `/tmp/happy-plugin.sock`. The relay is bound
only to host loopback and exists only for this plugin generation. Each connection must prefix the
generation's unguessable token before the relay opens the API socket, and every API request still
uses that token as bearer authentication. Both sides cap the relay at 64 concurrent connections
and close connections that do not finish their handshake within 30 seconds. Once authenticated,
an NDJSON or other streaming connection may remain idle without being mistaken for a dead
handshake. No `socat` or other runtime is silently injected; the image's Node provides the tiny
bridge.

The API token is mounted from a mode-0600 generation file and injected only into the bootstrap's
plugin child, so it is not retained in Docker's inspectable container environment. Rig does not
copy the host environment into the container: it keeps the image's own environment, passes only
locale, terminal, time-zone, and color settings from the host, and sets container-native
`HOME=/plugin-data` and temporary-directory variables for `/tmp`. Host credentials, executable
paths, sockets, and shell paths are never forwarded.

Docker plugin containers have a read-only root filesystem, a private tmpfs at `/tmp`, all Linux
capabilities dropped, `no-new-privileges` enabled, a 2 GiB memory limit, and a 512-process limit.
On native Linux the container uses Rig's host uid and gid so writes in `/plugin-data` remain
user-owned, and networking is disabled because the bind-mounted Unix socket needs no network.
Docker Desktop's authenticated host bridge requires bridge networking; that platform therefore
retains the image's ordinary outbound container networking under Rig's trusted-plugin model.
Docker Desktop must also allow bind mounts from both the installed plugin folder and Rig's own
installation folder, because the loader, SDK, bootstrap, and TypeBox runtime are mounted from
there. These normally live below the user's home folder. A package-manager installation elsewhere,
such as `/opt`, may need that path added in Docker Desktop's Resources > File Sharing settings.
Docker's original mount-denial text is retained in the plugin startup error.

Container names are deterministic from the installed folder and runtime generation. Ownership
labels let Rig remove every stale generation before startup, without deleting a foreign container
that merely collides by name. Exit, stop, failure, replacement, and uninstall remove containers;
upgrade and uninstall also attempt to remove superseded Rig-built images. Cleanup calls have
client-side deadlines. Transient cleanup failures are logged but do not turn an otherwise
successful install into a failure or prevent uninstall from removing plugin files and state. The
single ten-second startup budget covers Docker inspection and container creation as well as
`happy.ready(...)`. A stuck or unavailable Docker daemon therefore fails only that plugin
generation with a human-readable reason and never holds daemon startup open.

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
starting. Dockerfile discovery on catalog and log-read paths checks only the declaration and
Dockerfile; content hashing is deferred until image preparation or process startup actually needs
an image tag.

Every manifest also supplies one bounded `author` display label and one category from the public
catalog vocabulary. Icons are ordinary, manifest-owned square PNGs capped at 4 MiB and 2048 pixels.
The catalog publishes only `{ generation, mediaType, size }`; `generation` is the SHA-256 identity
of the validated bytes, never a path. Authenticated clients read those bytes through
`GET /plugins/<folder>/generations/<generation>/icon`. The manager reopens the current
manifest-owned file without following symlinks, revalidates it, and compares the digest before
serving it. Replacement during or after catalog reconciliation therefore returns
`stale_generation` instead of serving bytes from the wrong icon.

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

`PluginComputeRegistry` owns manifest-declared filesystem-and-command compute providers. A plugin
declares one stable provider name and attaches one generation-scoped NDJSON call stream with
`happy.compute.register`. Other plugins list and drive live providers through the same authenticated
socket. Each provider generation has one explicit `registered -> healthy -> degraded -> failed`
state machine. A deadline miss, transport failure, malformed/TypeBox-invalid completion, or typed
provider-side failure increments its consecutive-failure count. Two consecutive failures degrade
it; three fail it terminally. A successful call resets the count and restores a degraded provider
to healthy. Provider-returned `invalid_request`, `instance_not_found`, `provider_not_found`, and
`capacity_exhausted` errors are consumer-attributable and never affect provider health. The daemon
preserves provider error codes but derives retryability from the code and post-transition health;
it never trusts the provider's retryable field.

Stream loss fails a generation immediately and rejects all pending calls with `provider_lost`
instead of waiting for their deadlines. Failure terminally fails every materialized instance owned
by that generation; only a new plugin process generation can recover. Unprovisioned metadata
handles remain listable while their provider is offline. Provider appearance, health changes, and
disappearance invalidate the plugin catalog and publish the same whole-catalog `plugins_changed`
event used for plugin lifecycle changes. Both `GET /compute/providers` and the `/plugins` compute
contribution include `healthy`, `degraded`, or `failed` health.
They also expose the effective `provisioningTimeoutMs` for the active generation.

Instances are leased to the consumer plugin process generation that created them and follow one
stored `unprovisioned -> provisioning -> ready -> unavailable -> failed | stopped` lifecycle.
Creating a handle is metadata-only: it does not resolve the source path, contact a provider, or
wait for an environment. The first exec or file operation atomically moves `unprovisioned` to
`provisioning`, starts one background provider attempt, and immediately returns
`preparing_compute` with `retryable: true`. Concurrent callers observe the same provisioning state
and cannot create parallel sandboxes. Calls during transient recovery fail fast through the same
code instead of holding an inference request open.

Provisioning is a background job. The provider must acknowledge the job within 30 seconds, then
materialization and the final cheap `exec("true")` probe run under the provider's declared
`provisioningTimeoutMs`. The default is five minutes and Rig clamps declarations to a 30-minute
hard cap, which allows GPU providers to request a realistic 15-minute budget without weakening
ordinary operation deadlines. Missing the acknowledgment deadline is provider-attributable;
exceeding the overall job budget fails and resets the attempt without degrading provider health.

Provider handlers can report or heartbeat arbitrary human-readable phases such as "Requesting
instance", "Waiting for GPU capacity", and "Copying files to compute", with an optional percent.
Updates do not extend the overall budget. Silence does not fail a job before that budget expires;
the last known phase and update time remain visible instead.
Rig publishes durable `compute_preparation` events for preparing, provider phases, verification,
success, temporary unavailability and recovery, retryable failure, terminal failure, and
cancellation. Every attempt publishes a final event whose state is `ready`, `unprovisioned`,
`failed`, or `stopped`; terminalization emits from the single lifecycle transition, so concurrent
cleanup cannot double-publish. The durable global stream retains every provider progress report,
including percent-only updates within one phase. Phase or state transitions are also appended as
service notices to every matching, already-loaded session whose normalized `cwd` exactly matches
the retained local-directory `workspaceSource.path`, including subagents. Sessions in other
workspaces receive nothing, and cold sessions are not hydrated merely to receive progress.
Archived sessions cannot begin or resume a lifecycle, but one that observed a lifecycle before
archival receives its terminal settling row. Each row keeps a required text fallback and optional
structured compute detail: the classified error and canonical retryability, lifecycle state,
`startedAt`, `lastProgressAt`, elapsed time, phase, and the last reported percent survive
unchanged. Same-phase percent updates remain global-stream events but do not add chat history;
ready and failure always add final rows. Session-side phase coalescing is bounded and process-local, so restarting Rig
during preparation—or evicting state under extreme concurrency—may repeat the current phase once.
Notices use a dedicated durable service lane: they are ordered at their append position without
changing agent activity, unread state, or conversational turn budgets. A failed attempt emits a
typed `preparing_compute` error in its failure event, resets the handle to `unprovisioned`, and
lets the next use start a fresh single-flight attempt. It becomes terminally failed only after
materialization if its provider generation dies.

Event consumers must use the daemon-owned `state` as the authoritative lifecycle signal and treat
`phase` as display text only. The progress schema reserves `preparing_compute`,
`verifying_compute`, `ready`, `failed`, and `stopped` for daemon events. A provider attempting to
publish one of those names produces a provider-attributable `invalid_response` and no forged
preparation event.

Explicit stop transitions immediately to terminal `stopped`; provider cleanup is best-effort and
deadline-bound. Explicit stop, consumer cleanup, reaping, and daemon shutdown join one cleanup task
and cannot double-notify. One registry reaper enforces a two-hour maximum materialized lifetime
and 30-minute idle timeout, logs the attributed death reason, and avoids per-instance timers.
Never-materialized handles have a separate two-hour lifetime from handle creation so abandoned
metadata cannot exhaust the daemon-wide capacity. Provisioning is not reaped while its bounded
attempt is running; materialized lifetime and idle clocks begin when readiness is verified. Daemon
shutdown drains best-effort stops while provider streams are still available.

The registry retains at most 256 terminal tombstones with final state, reason, and created/died
timestamps, evicting oldest first. A call using a retained dead ID returns `instance_failed` and
the tombstone reason; `instance_not_found` means the ID never existed or its tombstone was evicted.
`GET /compute/instances` exposes the same lifecycle records to the owning consumer generation.

Every compute failure that crosses the socket uses the TypeBox-validated
`{ code, message, retryable, state? }` shape. While provisioning, `preparing_compute` also carries
`phase`, `startedAt`, `elapsedMs`, `lastProgressAt`, and optional `percent`, matching the visible
event stream. The public codes are `provider_not_found`,
`provider_unhealthy`, `provider_lost`, `instance_not_found`, `instance_failed`,
`preparing_compute`, `deadline_exceeded`, `capacity_exhausted`, `invalid_response`, and
`invalid_request`. `preparing_compute`, capacity exhaustion, and deadlines are retryable; dead
generations and terminal instance tombstones are not.

The first `workspaceSource` form is a local directory path retained as handle metadata. The
provider verifies it only when first use starts materialization, then owns copying, checkout, or
upload. This deliberately avoids both eager filesystem work and buffering arbitrarily large
workspaces through the socket. The SDK and registry are foundation only: custom computes are not
yet wired into agent session execution.

The provider write contract is atomic: the destination is fully replaced or left untouched.
Providers normally write a same-directory temporary file and rename it as the commit step.

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
serves these through `GET /plugins`, `GET /plugins/<name>/log`, and the generation-bound icon
route; `/plugins`, the `plugin_logs` agent tool, and `rig-connect` consume that boundary without
polling.

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
