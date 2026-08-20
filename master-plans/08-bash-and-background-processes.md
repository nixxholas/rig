# Master plan 8: Bash and background processes

## Big picture

An agent must be able to start a long-lived process — a dev server, a watcher, a
tunnel — and have it keep running. Today it cannot: our shell tools kill the
whole process tree when the tool call ends, so anything the command left behind
dies with it. That is the bug this plan removes.

The shape we want is simple. A shell command starts with a timeout. When the
timeout expires the command is not killed — it goes to the background and the
model gets its output so far plus a session it can come back to. Codex already
behaves this way by default, and it is the right default for us too; we should
not make the model think hard about timeouts.

Processes live as long as the daemon that started them. When the daemon dies,
everything it started dies with it. That has to be done carefully.

## What every model gets

These are capabilities, not a fixed set of tools. Every model must be able to do
all of them, but the tool names, argument shapes, and how the capability is
split across tools follow each vendor's own design.

1. **Run in background directly.** When the model does not care about the
   output, it says so and the command starts in the background immediately. It
   still waits about three seconds: if the command has not fallen over in that
   time, the tool returns and reports those three seconds. It is the same
   background-on-timeout mechanism with a small timeout.
2. **Stop a process.** A polite shutdown first, then a hard kill of the tree
   about two seconds later.
3. **Send characters to stdin.** Straight into the running process. Only Codex
   has this today; every model needs it.
4. **Read what a background process has produced since last time.** Only what
   accumulated since the previous read — we do not hand the whole log back
   again. Whether this is its own tool or folded into the stdin tool is the
   vendor's choice.

## Telling the model a process died

The model must not have to poll to find out that a background process exited.
If it never polled all the way to the end, it gets told.

The notification is a developer message, steered in the way we already steer
messages into a run. It says only that the process ended — nothing more, no
output attached. Getting the rest is the model's job, through the same read it
already has, and a finished process keeps answering that read for a while after
it exits.

An explicit agent abort is different. It covers the target agent and every
descendant agent. Before their background processes are signalled, the compute
module stores a one-shot notice for each affected agent in Compute's shared
Agent KV, scoped by affected agent identity, saying what the abort killed. Once
that write commits, process state moves to exited and every affected process
tree is sent an immediate hard kill; abort has no graceful waiting period. On
the agent's next inference, compute prepends the notice through its instructions
hook and consumes it. The notice is not a public history message and does not
create a queued conversation message.

## Lifetime

A background process belongs to the session that started it, and it lives as
long as that session's runtime lives inside the daemon.

- Aborting a turn kills every background process owned by that agent and every
  descendant agent immediately, after storing their one-shot compute notices.
- Recreating the session inside the same daemon does not keep them.
- Archiving a session kills everything it started.
- When the daemon exits, nothing it started survives.

There is a cap on how many background processes a session may hold. Reaching it
is not the model's problem to solve: the oldest session is evicted and killed,
the way Codex does it, rather than the model being handed an error.

We rely on ordinary process-group cleanup for this. Linux must be correct; on
macOS we accept that an abrupt kill of the daemon can leave orphans, and we are
not building a watchdog or writing special documentation for it.

## Terminals

Background commands run under a PTY, the way Codex does it: the model asks for a
TTY when it wants one, and the environment is set up to discourage terminal
output — `TERM=dumb`, no color, pagers forced to `cat`. Codex does nothing about
full-screen applications beyond that, and neither do we.

The user must be able to see which background processes are running and stop
them by hand. Beyond that, it would be good to attach to a background process
through our own terminal protocol and watch it live. That is worth doing only if
it costs nothing at execution time; if giving every process a libghostty
emulator makes running commands slower, we do not do it.

## Criteria

- A dev server started by an agent is still serving after the tool call
  returns, after the turn ends, and across later turns.
- Reaching the timeout backgrounds a command; it never kills it.
- Aborting a turn stores a one-shot notice in Compute's shared Agent KV for
  every affected agent and immediately hard-kills the complete process trees
  owned by that agent and every descendant agent. Compute prepends the notice
  to that agent's next inference and consumes it without adding it to public
  history.
- Archiving a session and exiting the daemon leave no background processes.
- Stopping a process is graceful first and forceful after about two seconds,
  and it takes the whole process tree.
- Every provider — Codex, Claude, Grok, Pi — can run in the background, stop a
  process, write to its stdin, and read its new output.
- A second read returns only what arrived since the first one.
- A background process that exits without having been read to the end produces
  a developer message saying so, carrying no output, and its remaining output
  is still readable afterwards.
- Passing the background-process cap evicts and kills the oldest one instead of
  failing the model's command.
- The user can see running background processes and stop them.
