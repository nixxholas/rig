# Happy module

`HappyModule` is the narrow agent-facing bridge to a connected Happy client. It owns durable
notification and status records in the Agent Base database, while the host owns the transport,
authentication, and client connection.

The module exposes `notify_happy`, `set_happy_status`, and `get_happy_status`.
`set_happy_status` commits its database mutation and tool result together. `notify_happy` is
non-durable because client delivery is an external side effect that cannot commit atomically with
the database. Client callbacks are registered with stdlib `afterCommit`, so a rolled-back agent
transaction never sends a notification or status update.
