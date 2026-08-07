# Master plan 17: Worklets

## Big picture

A worklet is a piece of compute that lives in Rig and runs in the background.
Not a task that finishes, not a command someone invokes — something that is
simply there, watching, polling, holding state, ready to answer.

It is written in TypeScript. Rig runs it, keeps it alive, gives it one folder
to write into, and lets it declare tools that any agent can call. That is the
whole idea.

Worklets are where the plugin idea goes. What we described as a plugin splits
into three ordinary things: a worklet for the background compute and its
tools, an applet for the interface, and skills for what agents should know.
Each of those is a simpler concept than a plugin was, and each stands on its
own. We are not building plugins now — worklets come first and matter more.

## What a worklet is

A worklet is global. It belongs to the Rig installation, not to a project or
a workspace, the same way applets do. Its tools are offered everywhere.

A worklet is TypeScript, built the way we build any code we run. It is
installed by importing a source folder under a human-readable kebab-case name.

A worklet is installed and versioned exactly as an applet is. It lives in
`<home>/Happy/Worklets/<name>/`: the first import goes into `v1`, the next into
`v2`, every update carries a description of the change, and any earlier version
can be made current again without deleting the others. Its icon sits in the
worklet's root folder, next to the versions, the way an applet's favicon does.

Alongside the versions is `Data`, and that folder is the point. Versions come
and go beside it; the data stays. A worklet updated ten times is the same
worklet with the same state.

```
<home>/Happy/Worklets/<name>/favicon.png
<home>/Happy/Worklets/<name>/Data/
<home>/Happy/Worklets/<name>/v1/
<home>/Happy/Worklets/<name>/v2/
```

For now there is no security model for the code itself. We trust what we
install. The one boundary we do enforce is the filesystem: a worklet may write
into its own `Data` folder and nowhere else — not even into its own version
folders.

Worklets are headless. A worklet has no interface of its own — when something
needs to be seen, that is an applet, and it talks to the worklet.

## Sleep

A worklet is meant to be running all the time, and to cost nothing while it is.
The first version can just stay up; that is fine and it is where we start. The
concept, though, is that a worklet sleeps whenever it has nothing to be awake
for, and that this is the normal state rather than an optimization.

A worklet is awake because something asked it to be. Four things wake it:

- an agent calling one of its tools;
- a timer it declared — a poll every minute, a job every night;
- an incoming HTTP request on an endpoint it declared, which Rig serves on its
  behalf;
- a Rig event it subscribed to.

When none of those is outstanding — no polling loop running, no request in
flight, no timer due — the worklet goes to sleep, and the machine should not be
able to tell it exists. Waking must be fast enough that nobody notices it
happened: an agent calling a tool on a sleeping worklet just gets its answer.

## Tools

A worklet declares tools, MCP-shaped, and those tools become available to
agents like any other tool. This is the main reason to write one. The worklet
holds the state, does the watching, talks to whatever it talks to, and exposes
the few operations an agent actually needs.

## The surfaces

Three surfaces, and all three exist for every worklet:

- **The API.** HTTP on the daemon: install a worklet from a folder, list them,
  update to a new version, revert to an old one, remove one, read its status
  and its logs, and reach the endpoints a worklet declared.
- **Tools.** Common tools, available to every model, so an agent can install a
  worklet, list what is installed, update it, revert it, remove it, and read
  its logs — the same way agents create applets and slot entries today.
- **`rig-connect`.** Worklets are entities the client holds and follows:
  fetched by request-response, kept current from the global event stream, with
  their current version, whether they are awake or asleep, and their status.

## The steps

**A. The runtime.** Install a worklet by importing a folder, build its
TypeScript, run it, capture its logs, and confine its writes to its `Data`
folder. The `<home>/Happy/Worklets/<name>/` layout — icon in the root,
`v1`, `v2`, and `Data` beside them — with change descriptions and revert, and a
`Data` folder that survives every version change. Done when a worklet installed
from a folder runs in the background, writes state that outlives an update, and
cannot write anywhere else.

**B. Tools.** A worklet declares its tools, and agents in normal sessions can
call them. Done when an agent calls a worklet tool and the worklet answers.

**C. Wake and sleep.** Declared timers, declared HTTP endpoints served by Rig,
event subscriptions, and tool calls — each of them a reason to be awake. A
worklet with nothing outstanding sleeps. Done when an idle worklet consumes
nothing measurable and a tool call, a request, a timer, and an event each wake
it quickly enough to be invisible.

**D. API, tools, and `rig-connect`.** The full management surface over HTTP,
the common agent tools that drive it, and worklets as live entities in
`rig-connect`. Done when an agent can install and update a worklet without
leaving a session, and a client shows every worklet, its version, its status,
and whether it is awake, without polling.

## What done looks like

- Writing background compute for Rig means writing TypeScript and importing a
  folder.
- A worklet is global, versioned like an applet, and revertible without losing
  history.
- Its data folder is the durable thing; versions change above it.
- A worklet writes into its data folder and nowhere else.
- A worklet's tools are callable by any agent, everywhere.
- A worklet is awake only for a tool call, a timer, a request, or an event, and
  costs nothing otherwise.
- Everything about worklets is reachable three ways: the API, common agent
  tools, and `rig-connect`.
