# Master plan 13: Extensions

## Big picture

Anyone — a person or an agent — should be able to write a bit of code that runs
inside Rig and extends it. We call that an extension.

An extension is TypeScript. The daemon runs it as a separate process inside a
sandbox, hands it a socket, and the extension talks to Rig over that socket
through a library with a predictable API. From there it can do the things Rig
itself can do: create a workspace, add to it or remove from it, send a message
to any agent, and so on.

The exact scope of what an extension may call matters much less right now than
the plumbing. What we need first is a library with an API good enough to build
an application against, and a runtime that starts it, isolates it, keeps its
logs, and shuts it down.

## The library

A package — `rig-plugins` — is the extension author's whole view of Rig. It
gives typed actions and nothing else: no transport details to think about, no
credentials to find. It reads the socket path and the token from environment
variables, connects, and exposes the API.

The API is the product here. It should read like an SDK someone would enjoy
writing an application against, and it should be stable enough that extensions
written today keep working. Start with the obvious actions — workspaces,
sessions, messages to agents — and grow the surface as extensions ask for it.

## The runtime

Extensions are written only in TypeScript. The leaning is that we simply build
an extension on startup rather than interpreting it as we go. We use
TypeScript 7 and its compiler for that.

Every Rig carries its own copy of the SDK, and when it builds an extension it
substitutes that module for the one the extension imports. So the build is also
the check: at least at the TypeScript level, we learn whether this extension
still fits this Rig before it runs.

Each extension is its own process. The daemon creates a Unix socket for it
inside its sandbox, passes the socket path and a token through environment
variables, and the extension connects back. The token is what authorizes the
socket; nothing else is trusted.

The sandbox is the one we already have — Seatbelt on macOS, the Linux
mechanisms elsewhere — probably a little less restricted than an agent command,
and possibly exactly the same. We do not build a second isolation mechanism for
extensions.

The daemon tracks each extension's logs and makes them viewable, and it looks
good in the interface. An extension author debugging their code should reach
for Rig's log view, not for a container log.

## Installation

An extension is installed into a folder. Not into a private, hidden internal
directory — it goes into a folder the user can see and open, and each extension
gets its own folder inside that shared one.

The extension may write inside its own folder. That is where its state lives.

## Registration

An extension registers itself with a JSON manifest. That manifest is what Rig
reads to know the extension exists, what it is called, what it needs, and what
it contributes.

Every extension must have an icon, and the icon is generated. An extension
without one does not register.

Most extensions for Rig will be written inside Rig, by people and agents working
there. So Rig itself has to hand the author the relevant skill for producing
that image, at the moment they are building the extension. The icons must come
out consistent with each other. The prompt behind that skill is roughly:
Jobs-era iPhone icons.

## What extensions can extend

The first extension point is MCP. An extension can start an MCP server and
expose whatever tools it wants — an MCP for computer use, for instance. That is
a simple thing to build and immediately useful.

Those MCP servers get forwarded into projects. For now we simply offer them
everywhere and leave it up to the model to work with them sensibly.

The second extension point is UI. An extension can contribute an interface that
drives a browser. In effect these extensions are MCP Apps: the extension returns
static HTML and Rig embeds it.

The one thing that matters about embedding is that it is instant. The user
presses a button and the application is mounted at that same moment. Not an
iframe that starts loading something. Because we are on Electron, we can host it
in a proper, good-looking isolation mechanism, but that costs work and comes
later.

## Trust

We are not building a security model for extensions. We relatively trust the
extensions we wrote, and we do not restrict what they may reach — whether an
extension can create a workspace somewhere else, or anything of that kind, is
not a question we answer with a permission check.

There is no clever identifier scheme either. We considered one and decided
against it.

## Reference

Happy2 has a cloud extension system worth looking at — it is genuinely nice.
Take its good ideas and leave the machinery that does not fit a local product.

## The steps

**A. The library and the plumbing.** `rig-plugins` with a predictable API, the
JSON manifest, the daemon-side runtime that starts an extension process in the
sandbox, the socket and token handshake, log capture and a log view in the
interface. Done when an extension written in TypeScript can be started by the
daemon, call a basic set of Rig actions — create a workspace, modify it, send a
message to an agent — and have its output readable in the UI.

**A2. The icon skill.** A skill that generates an extension's logo, offered to
whoever is building an extension inside Rig. Done when an author gets the skill
without asking for it and the icons produced across extensions look like they
belong together.

**B. MCP servers.** An extension starts an MCP server; Rig forwards its tools
into projects, everywhere by default. Done when an extension-provided MCP tool
can be called by a model in a normal session.

**C. UI.** An extension contributes static HTML that Rig mounts instantly on a
button press, isolated properly under Electron. Done when pressing the button
shows the extension's application with no loading step.

## Criteria for the whole plan

- Writing an extension means writing TypeScript against one library with a
  predictable API, plus a JSON manifest, and nothing else.
- An extension is built on startup against the SDK this Rig ships, so an
  incompatible extension is caught by the compiler instead of at runtime.
- Every registered extension has a generated icon, and the icons look like one
  family.
- Extensions run as sandboxed processes reached over an authenticated socket,
  under Rig's existing sandbox rather than a new one.
- Each extension lives in its own folder inside a user-visible folder and can
  write there.
- Their logs are captured by the daemon and pleasant to read in the interface.
- An extension can add MCP tools that models actually use, and a UI that mounts
  the instant the user asks for it.
