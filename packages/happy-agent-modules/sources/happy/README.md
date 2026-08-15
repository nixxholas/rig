# Happy module

`HappyModule` is the narrow agent-facing bridge to a connected Happy client. It owns durable
notification and status records in the Agent Base database, while the host owns the transport,
authentication, and client connection.

The module exposes `notify_happy`, `set_happy_status`, and `get_happy_status`. Mutating tool calls
use Agent Base's durable call identity as their operation identity. The client callback is
registered with stdlib `afterCommit`, so a rolled-back agent transaction never sends a notification
or status update.