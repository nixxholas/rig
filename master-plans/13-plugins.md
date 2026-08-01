# Master plan 13: Plugins

## Big picture

Anyone — a person or an agent — should be able to write a bit of code that runs
inside Rig and extends it. We call that a plugin.

A plugin is TypeScript. The daemon runs it as a separate process inside a
sandbox, hands it a socket, and the plugin talks to Rig over that socket
through a library with a predictable API. From there it can do the things Rig
itself can do: create a workspace, add to it or remove from it, send a message
to any agent, and so on.

The exact scope of what a plugin may call matters much less right now than
the plumbing. What we need first is a library with an API good enough to build
an application against, and a runtime that starts it, isolates it, keeps its
logs, and shuts it down.

The idea behind all of it: starting a plugin is simpler than building some
elaborate orchestration system. It is far easier to tell a model to write a
plugin that does exactly what is needed than to try to balance everything
with prompts.

## The library

A package — `happy-plugins` — is the plugin author's whole view of Rig. It
gives typed actions and nothing else: no transport details to think about, no
credentials to find. It reads the socket path and the token from environment
variables, connects, and exposes the API.

The API is the product here. It should read like an SDK someone would enjoy
writing an application against, and it should be stable enough that plugins
written today keep working. Start with the obvious actions — workspaces,
sessions, messages to agents — and grow the surface as plugins ask for it.

## The runtime

Plugins are written only in TypeScript. The leaning is that we simply build
a plugin on startup rather than interpreting it as we go. We use
TypeScript 7 and its compiler for that.

Every Rig carries its own copy of the SDK, and when it builds a plugin it
substitutes that module for the one the plugin imports. So the build is also
the check: at least at the TypeScript level, we learn whether this plugin
still fits this Rig before it runs.

Each plugin is its own process. The daemon creates a Unix socket for it
inside its sandbox, passes the socket path and a token through environment
variables, and the plugin connects back. The token is what authorizes the
socket; nothing else is trusted.

The sandbox is the one we already have — Seatbelt on macOS, the Linux
mechanisms elsewhere — probably a little less restricted than an agent command,
and possibly exactly the same. We do not build a second isolation mechanism for
plugins.

The daemon tracks each plugin's logs and makes them viewable, and it looks
good in the interface. A plugin author debugging their code should reach
for Rig's log view, not for a container log.

## Startup and readiness

A plugin does not just start — it reports back. On start, and on install, it
has a window of time — say ten seconds — to come up, register its name and
its tools, put its hooks in place, and declare itself ready. Rig records what
the plugin registered. A plugin that does not report ready in time did not
start.

The daemon waits for all plugins to finish starting before it begins doing
anything. All plugins start concurrently — one slow or broken plugin must not
serialize the others or push the daemon into timeouts.

A plugin also has a status: a string it can write at any time, shown in the
interface — working, loading, will be ready soon, broken. The status is the
plugin's own words about itself.

## Events

Plugins can subscribe to events: a session started, a session ended, and a
large list beyond that. These events are most likely the same things we put
into durable events — one stream, not a parallel invention.

A plugin can register a hook at registration time, simply reacting to an
event, and it can subscribe and unsubscribe dynamically while it runs. There
is one synthetic event — OnReady — fired when the daemon has started and
every plugin has initialized.

## Dependencies

Plugins can call each other, but only through declared dependencies. A plugin
that wants to create documents through a documents plugin must declare that
it depends on it. It does not install if the dependency is not installed, and
it does not start if the dependency is not running. Failure cascades: if a
dependency fails to start, everything depending on it does not start either,
down the chain.

None of this blocks anyone else's startup. All plugins launch at the same
time; dependency failure takes out its own chain and nothing more.

## Settings

A plugin can have settings: key-value pairs, each with a type. For now the
types are text and secret — nothing more yet. Some settings are required and
the plugin does not start until they are set; others are optional. All of it
is described in the plugin's JSON manifest.

## Docker

A plugin can request Docker access in its manifest, and then it gets the
Docker socket, on any platform. Since a plugin itself is just JavaScript, the
strong recommendation is: anything heavy or unusual it needs to run should go
into containers, not onto the system.

## Installation

A plugin is installed into a folder. Not into a private, hidden internal
directory — it goes into a folder the user can see and open, and each plugin
gets its own folder inside that shared one.

The plugin may write inside its own folder. That is where its state lives.

## Registration

A plugin registers itself with a JSON manifest. That manifest is what Rig
reads to know the plugin exists, what it is called, what it needs, and what
it contributes.

Every plugin must have an icon, and the icon is generated. A plugin
without one does not register.

Most plugins for Rig will be written inside Rig, by people and agents working
there. So Rig itself has to hand the author the relevant skill for producing
that image, at the moment they are building the plugin. The icons must come
out consistent with each other. The prompt behind that skill is roughly:
Jobs-era iPhone icons.

## What plugins can extend

The first plugin point is MCP. A plugin can start an MCP server and
expose whatever tools it wants — an MCP for computer use, for instance. That is
a simple thing to build and immediately useful. One plugin has exactly one
MCP server, no more. Its tools are named `mcp_<plugin>_<tool>` — the prefix,
then the plugin's name, then the tool.

Those MCP servers get forwarded into projects. For now we simply offer them
everywhere and leave it up to the model to work with them sensibly.

The second plugin point is UI. A plugin can contribute a static, built web
application, and Rig serves it as static files. The application gets an API
it can use to talk to the system from inside. It can call its own plugin's
MCP, and the MCPs of the plugins it depends on — from the UI, and from plugin
code alike.

The kinds of applications we mean: a kanban board, usage tracking, a
Linear-style triage of incoming tasks, a monitoring system. A GitHub plugin
that puts a watcher on repositories and says when something broke. Things
like that.

The one thing that matters about embedding is that it is instant. The user
presses a button and the application is mounted at that same moment. Not an
iframe that starts loading something. Because we are on Electron, we can host it
in a proper, good-looking isolation mechanism, but that costs work and comes
later.

## Trust

We are not building a security model for plugins. We relatively trust the
plugins we wrote, and we do not restrict what they may reach — whether a
plugin can create a workspace somewhere else, or anything of that kind, is
not a question we answer with a permission check.

There is no clever identifier scheme either. We considered one and decided
against it.

## Reference

Happy2 has a cloud plugin system worth looking at — it is genuinely nice.
Take its good ideas and leave the machinery that does not fit a local product.

## The steps

**A. The library and the plumbing.** `happy-plugins` with a predictable API, the
JSON manifest, the daemon-side runtime that starts a plugin process in the
sandbox, the socket and token handshake, log capture and a log view in the
interface. Done when a plugin written in TypeScript can be started by the
daemon, call a basic set of Rig actions — create a workspace, modify it, send a
message to an agent — and have its output readable in the UI.

**A2. The icon skill.** A skill that generates a plugin's logo, offered to
whoever is building a plugin inside Rig. Done when an author gets the skill
without asking for it and the icons produced across plugins look like they
belong together.

**B. Readiness and status.** The startup handshake: a plugin gets its window
to register tools and hooks and report ready, the daemon waits for all
plugins before doing anything, all of them starting concurrently, and the
plugin's status string shows in the interface. Done when a slow plugin times
out cleanly without delaying the others, and the user can see each plugin's
readiness and status.

**C. MCP servers.** A plugin starts its one MCP server; Rig forwards its
tools — named `mcp_<plugin>_<tool>` — into projects, everywhere by default.
Done when a plugin-provided MCP tool can be called by a model in a normal
session.

**D. Events.** Subscription to the durable-event stream, hooks registered at
registration, dynamic subscribe and unsubscribe, and the synthetic OnReady.
Done when a plugin reacts to a session starting and ending, and OnReady fires
once after the daemon and all plugins are up.

**E. Dependencies, settings, Docker.** Declared dependencies with cascading
failure that never blocks unrelated plugins; key-value settings typed text or
secret, required and optional, in the manifest; Docker access on request.
Done when a plugin refuses to install without its dependency, refuses to
start without a required setting, and a plugin that asked for Docker can
reach the socket.

**F. UI.** A plugin contributes a static built web application that Rig
serves and mounts instantly on a button press, isolated properly under
Electron, with an API to the system and to the MCPs of its dependencies. Done
when pressing the button shows the plugin's application with no loading step
and the application can call an MCP tool.

## Criteria for the whole plan

- Writing a plugin means writing TypeScript against one library with a
  predictable API, plus a JSON manifest, and nothing else.
- A plugin is built on startup against the SDK this Rig ships, so an
  incompatible plugin is caught by the compiler instead of at runtime.
- Every registered plugin has a generated icon, and the icons look like one
  family.
- Plugins run as sandboxed processes reached over an authenticated socket,
  under Rig's existing sandbox rather than a new one.
- Each plugin lives in its own folder inside a user-visible folder and can
  write there.
- Their logs are captured by the daemon and pleasant to read in the interface.
- A plugin reports ready within its window or is treated as not started; the
  daemon waits for all plugins, which start concurrently, before doing
  anything.
- One MCP server per plugin, tools named `mcp_<plugin>_<tool>`, offered
  everywhere.
- Plugins react to the same events we keep as durable events, can subscribe
  dynamically, and get one synthetic OnReady.
- Dependencies are declared; a missing or failed dependency takes out its own
  chain and nothing else.
- Settings are typed key-value pairs — text or secret — with required ones
  gating startup, all in the manifest.
- A plugin that requests Docker gets the socket; heavy software belongs in
  containers, not on the system.
- A plugin can add MCP tools that models actually use, and a UI that mounts
  the instant the user asks for it and can talk to the system and its
  dependencies' MCPs.
