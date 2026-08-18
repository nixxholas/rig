# Happy module

`HappyModule` is the narrow agent-facing bridge to a connected Happy client. It owns durable
notification and status records in the Agent Base database, while the host owns the transport,
authentication, and client connection.

The module exposes `notify_happy`, `set_happy_status`, and `get_happy_status`.
`set_happy_status` commits its database mutation and tool result together. `notify_happy` is
non-durable because client delivery is an external side effect that cannot commit atomically with
the database. Client callbacks are registered with stdlib `afterCommit`, so a rolled-back agent
transaction never sends a notification or status update. They run on the caller's context, whose
database handle is still open once the module's own transaction has closed.

`set_happy_status` is durable, so running the same tool call again must be safe. Each status
operation is recorded under the call that made it: a repeat of a recorded operation restores
exactly the status it wrote and tells the client nothing a second time, whatever happened in
between.

The host is called through the object that supplied it, so a class-backed adapter keeps its own
receiver. Notifications and status records are cloned before delivery, so a host cannot change what
the caller was handed. Writes are serialized, so two callers never open competing transactions on
the same storage.
