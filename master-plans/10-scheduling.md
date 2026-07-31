# Master plan 10: Scheduling

## Big picture

Every model, across every provider, gets `wait` and `wait_until`. Agents that
are not subagents also get `schedule_message`. Their names use `snake_case`.

`wait` pauses an agent for a duration. Durations can be expressed in seconds,
hours, or days, with several forms allowed. Waits can be very long, up to
around 24 hours. `wait_until` does the same thing, but takes a date in formats
the model can express.

## Durable waits

Waits survive a daemon restart. While an agent is waiting, the session state
shows that the session is simply waiting.

Any message into that chat interrupts the wait. The agent is told that the wait
ended early and how much time actually elapsed.

## Scheduled messages

`schedule_message` is never available to subagents. For other agents, it sends
a message at a scheduled time to any agent in the system whose Agent ID the
sender knows, including itself. If the message is not delivered, the sender
keeps it.

Scheduled messages and all of their updates synchronize on reconnect, so they
can be shown in the UI later. The user can cancel a scheduled message by hand.
Stopping an agent does not remove scheduled messages from history.

## What done looks like

- Every model and provider has the `snake_case` `wait` and `wait_until` tools.
  Agents that are not subagents also have `schedule_message`; subagents never
  do.
- Long waits accept durations in seconds, hours, or days, and dated waits accept
  dates in formats models can express.
- Waits survive daemon restarts, appear as waiting in session state, and are
  interrupted by any new message in the chat with the actual elapsed time
  reported to the agent.
- Scheduled messages can target any known Agent ID, including the sender, and
  remain with the sender if they are not delivered.
- Scheduled messages and their updates synchronize on reconnect, remain in
  history when an agent stops, and can be cancelled by the user.