# Master plan 2: the terminal protocol

## Big picture

Rig has its own protocol for remoting a terminal, built on libghostty. The idea
is that both sides run libghostty — the server holds the canonical emulator, the
client holds a replica — and the protocol keeps the two states synchronized.

Think of it like RDP: the client first gets the current picture, and after that
it receives only ultra-efficient deltas. RDP was always dramatically more
efficient than shipping images or video because its cost is nearly constant.
Ours works the same way, and we do not compute any diffs to get there — the
ordered terminal bytes themselves are the delta, applied by the same emulator on
the other side.

## The goal

The protocol must be efficient, with minimal latency, and better than the
existing alternatives — better than SSH. Unlike SSH, it must survive the real
world: it reconnects, it tolerates lost packets, it recovers its state, and the
user never has to care that any of that happened.

## Status

Right now the protocol is, in essence, proprietary: there is no specification,
nothing of the sort. It was created exclusively to work inside Happy and Rig.
In the future it may well be improved, but for now it is simply what it is.

## Criteria

- Both ends run libghostty, and the protocol synchronizes their state; the
  client renders a replica of the server's terminal, not a video of it.
- Snapshot first, deltas after — the RDP shape. Steady-state cost stays near
  constant and far below sending images or video.
- No diff computation in the hot path; replaying the terminal byte stream is
  the delta mechanism.
- Minimal latency: output reaches the client's screen as fast as the transport
  allows.
- More robust than SSH: reconnection, packet loss, and state recovery are part
  of the protocol, not a session-ending failure.
