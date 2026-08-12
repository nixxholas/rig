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
