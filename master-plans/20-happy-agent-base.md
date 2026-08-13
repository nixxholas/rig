# Master plan 20: happy-agent-base

## Big picture

This is designed without looking at the existing code. The goal is to replace
the overloaded parts of the current system with an agent core that can be
launched with different parameters and different extensions.

The most basic thing an agent is, is its event loop: a message comes in, a
message comes out, plus steering. That is all. Around that core there are three
million things one ends up needing — launching applications, launching
terminals, subagents, and so on. The problem is that all of it overlaps, and
the code becomes unbearably heavy. So the aim is a maximally minimal agent
system that can be extended with practically any functionality that could
exist.

## Features

Extensions are called features. A feature is an object with a set of functions
that hook callbacks into completely different places in the agent loop. For
example, a feature supplies the list of tools for each turn — a function that
returns tools.

Two examples of how features work:

- Goal. Goal is a tool plus a hook: when a turn ends and the goal is still
  set, the feature sends a special prompt so the model keeps going. That is
  the whole thing. There is no UI and nothing else to customize — a feature
  only works with the context and modifies things.
- Auto review. When a session starts, we must be able to launch a new session
  for auto review. It lives only in the daemon; we drive its context by hand.
  It still works as an ordinary separate feature.

## AgentBase

The bootstrap is a base class, AgentBase, which represents a session. You can
send messages to it and receive messages from it. It takes a provider —
probably a collection of providers, allowing switching between them similar to
the original. It takes session storage and, apparently, agent storage. The
main point: it is a single agent, and nothing more.

## AgentBase state

Conceptually, agents are very similar to actors. The nuance is that actors are
sometimes not very convenient to work with, so we work with agents more like
classes, objects, and so on.

Abort must be as fast as possible. We abort any agent execution immediately.
This differs from an actor, which waits to receive messages. In principle, an
actor can probably do this too, but usually it still waits for messages. Even
so, agents are very close to actors.

AgentBase state relies on transactions. Several changes are written at once,
and some hooks can run inside the same transaction when they write. This lets
us do relatively simple things without double commits.

The state explicitly records whether there is anything to do. At the simplest
level this is a binary flag: active or not. It also records the stage where the
agent stopped. From that stage we understand whether to run inference, run
tools, or continue something such as compaction.

If we emitted an event for a block and crashed in the middle of inference,
restart must emit a block reset so everything remains consistent. We persist
only completed blocks, so this should not affect anything except what the user
sees.

Only one state is exposed outside AgentBase: whether it is active, literally
through a getter. Loading an agent becomes loading its state from disk. More
precisely, we load only the flag, so this is as fast as possible. Everything
else, including history, loads asynchronously. We keep the state in memory as
a fixed variable.

Steering, sends, and the rest cannot be read. They can only be cleared. Nobody
is allowed to read them. The only thing anyone can read is whether the agent is
active. Even that is not really needed, though it may be needed when restarting
an agent.

If the flag says there is work to do, the loop can determine what is needed.
Steering, the queue, and the rest are already persistent, so this should be
relatively natural.

We need separate hooks that can participate in a transaction, for example the
completion transaction in on settled. Their suffix, such as transact or
transactable, distinguishes operations that run inside the transaction.

When a tool starts, we create a subpath where the tool can write its state if
it is durable. A tool that is not durable cannot be retried and simply fails
on retry. All pending states are deleted completely when a turn finishes.

We also clear data as soon as it is no longer needed. Once all tool calls have
run and been saved in history, the tool cache is deleted immediately because
everything is already committed.
