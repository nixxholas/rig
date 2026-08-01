# Master plan 11: Presence

## Big picture

Long-running agents must not require the human to remain nearby. Work can take
from less than an hour to most of a day, while questions arrive at unpredictable
times and require the human to recover their own context before answering.

Presence tells every agent whether the human can be reached and how to proceed
when a response is unavailable. The built-in states are Online and Away, and the
human can create custom states.

## Online and Away

Online preserves the current behavior: the human is reachable, and an agent may
wait indefinitely for an answer.

Away means that the human cannot be reached. Any attempt to ask a question,
request permission, or stop for human input becomes an asynchronous,
non-blocking message. The agent is told that the human is unavailable and must
continue on its own without waiting.

The Inbox remains the shared place for these messages, but putting something
there must not always block the session.

## Custom states

A presence state says whether the human is reachable, how long an agent may wait
for an answer, what the model should be told about the state, and any additional
instructions for working in it.

Waiting is configured per state. It may be unlimited, immediate, or finite. For
example, a custom state may wait for 15 minutes and then tell the model to
continue on its own because an answer is no longer expected.

## Model awareness

The current presence state is injected into every model. When it changes during
work, the model receives a system notice explaining the new state and its
instructions, such as that the human has gone Away and can no longer be reached.

## Temporary and scheduled presence

A state can be set for a duration or until a particular time, such as for eight
hours, until tomorrow, or until tomorrow morning. When setting it, the human
also chooses the state to return to when it expires.

Presence can change automatically on a schedule. Schedules cover recurring
periods such as every day, weekdays, or weekends, as well as specific dates.

## What done looks like

- Online waits indefinitely for human input, while Away never waits and tells
  agents to continue autonomously.
- Questions, permission requests, and other attempts to get human input follow
  the active state's wait behavior without losing their place in the Inbox.
- Custom states combine reachability, a response timeout, model-facing context,
  and the human's own working instructions.
- Every model receives the current state and is notified when it changes during
  a run.
- Temporary states expire into a chosen fallback state.
- Recurring and date-specific schedules can activate presence states
  automatically.
