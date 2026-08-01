# Master plan 11: account routing

## Big picture

A person can have more than one account with the same vendor: two Codex logins,
several Claude tokens, a Bedrock key. Today each of those is just another
provider entry, and the only way to use the second one is to pick it by hand
every time.

Rig should route requests across those accounts by itself. Routing is Rig's
job, not the model's. A model is never required to pick an account, never told
to reason about which one it is on, and never given a tool that changes this
state. From above, a session simply keeps working; underneath, the request may
have gone to a different account than the last one did.

A model can still name a visible account when it creates a subagent, the same
way it names a model today. That is a choice a person's prompt asks for, not
something Rig makes it do.

## Primary and secondary accounts

An account may be declared secondary to another account. The account it points
at is the primary, and the primary is what the user and the model see.

Secondary accounts can be hidden from the rest of the system, so no model ever
sees them and no subagent can be created on them. Hiding is optional: a user who
wants a model to be able to assign work to a specific account can leave it
visible.

All of this is configuration. It lives in the config file, in code, and nowhere
else for now — no API to change it, no UI to edit it. Everything else in the
product must work through it transparently.

## Compatibility

Rig may only route between accounts that are truly interchangeable for the model
being used. What matters is the pair of model and provider.

Accounts in one routing group must be the same type. Anthropic's cloud and
Bedrock are not compatible with each other. Two Bedrock accounts in different
regions are not compatible either; the same Bedrock account in the same region
is fine. When accounts are not compatible, they are not alternatives, and Rig
must not silently move work between them.

## Knowing when an account is spent

Rig learns that an account is out of budget in two ways: from the error a
request comes back with, and from the vendor's own usage API. When a request
fails in a way that suggests exhaustion, Rig asks the vendor for the current
subscription and usage and updates what it knows. A response that says there is
no money or no remaining quota counts the same way.

Usage has to be captured for every vendor and every transport we support, not
only the ones where it was easy.

## The router

Every account carries a router describing how its group is used. There are three
kinds.

**Manual.** The user picks the account by hand. Turning on a fallback switches to
another account and everything continues exactly as before.

**Round robin.** The account is chosen at random from the group. The choice is
made when a chat starts, or after an hour of idleness; as long as the chat keeps
going, Rig stays on the account it already picked and gets as much out of it as
it can. Accounts can carry weights, so one is chosen more often than another.

**Smart routing.** Like round robin, but it looks at how much usage is actually
left in each account and refreshes that every fifteen minutes. It comes in two
shapes. _Balanced_ spreads spend across the group, preferring the accounts that
have been used least, with weights so one account can be made to drain twice as
fast as another. _Priority_ uses a default account until it runs out, then moves
to the next one; every fifteen minutes it rechecks which accounts are still
alive.

In any router, an account can also declare when it is allowed to be used —
days and hours, written the way a person would say it. Some accounts only during
working hours, some only outside them.

## Seeing the state

Rig exposes the state of every account, including usage, through a plain request
that returns all of it at once. Clients poll it from time to time. There are no
durable updates and nothing to push.

## Order and criteria

First make usage reliable: every vendor and transport reports it, and the
exhaustion signals from errors and from the vendor usage API both land in the
same place. Then add secondary accounts and compatibility groups in the config,
with optional hiding. Then the routers, in order: manual, round robin, smart.
Finally the query that returns the state of all accounts.

This plan is done when:

- Several accounts of the same type can be configured, one primary with
  secondaries attached, and secondary accounts can be hidden from models and
  subagent creation or left visible.
- Rig routes between compatible accounts on its own, without the model choosing
  or being asked to choose; a model may still name a visible account when a
  person's prompt tells it to.
- Incompatible accounts — Anthropic cloud against Bedrock, Bedrock across
  regions — are never used as substitutes for one another.
- Exhaustion is detected from request errors and confirmed against the vendor's
  usage API, for every vendor and transport.
- Manual, round robin, and smart routing all work, including weights, the
  chat-start and one-hour-idle re-pick, the fifteen-minute usage refresh, and
  balanced against priority selection.
- Accounts can be restricted to given days and hours.
- A single request returns the state and usage of every account, and clients
  poll it.
