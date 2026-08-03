# Session-sharing persistence

These synchronous operations own the durable owner-share, grant, outbox, friend-message context,
and member-replica state. Multi-row lifecycle changes use `inTx`; queries remain ordered and
bounded. Transport and service behavior live outside persistence and do not issue SQL.
