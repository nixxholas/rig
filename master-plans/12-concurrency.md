# Master plan 12: concurrency

## Big picture

Concurrency in Rig is written with a handful of small primitives and nothing
else. Every one of them is a plain lowercase function we compose, not a class
to extend. They may hold an object or a class inside, but the thing we pass
around and build with is the function.

The point of keeping the set small is that all the concurrency in the product
should be readable as an arrangement of these few pieces. Anything that reaches
for a semaphore, a bespoke scheduler, or a hand-rolled promise chain is a sign
we skipped one of them.

## Locks and queues

The base primitive is an async lock: an object with an asynchronous `runInLock`
that takes a function and runs it while holding the lock. That is the whole
interface. Semaphores are almost never needed; a lock is enough.

A queue is built on the lock, and in truth it is the same thing — a lock
already guarantees order, so `asyncQueue` and `asyncLock` are functionally
identical. We keep both names because at a call site one word is sometimes
clearly the right one.

## Delay

There are two delays. The plain one just waits. The other takes an abort signal
and waits either for the time to pass or for the program to begin shutting
down.

When a delay is aborted it throws an abort exception. That exception is thrown
everywhere abort happens, and it is handled or passed further up at whatever
level actually cares. It is normal, not a failure.

## Backoff, retry, and forever

`backoff` runs a function with exponential backoff, repeating until the
function succeeds or the program starts shutting down. It accepts an abort
signal. By default a backoff is infinite.

`retry` is a backoff bounded by a limited amount of time. If the work has still
not succeeded when that runs out, it throws.

`forever` takes a delay and a function and calls `backoff` over and over until
the application stops. It is a `while (true)` with a backoff inside it, an
abort signal, and the delay between passes.

Every `forever` carries a string name. The name is used in logs and, more
importantly, it is what tells us which loop is holding up a shutdown.

## Graceful shutdown

Graceful shutdown is a map from a name to an asynchronous handler. A handler is
registered under its name and runs when the daemon begins shutting down. The
daemon waits for all of them to finish.

The names are the reason this exists in this shape. When shutdown is slow, the
names say exactly what we are waiting for — including which `forever` has not
yet come out of its loop.

## Polling provider usage

Provider usage is the first thing built on these primitives, and it should stay
about as simple as the primitives themselves.

Each provider gets a `forever` that asks that provider for its usage every
fifteen minutes and keeps the answer, with the time it was taken, in a plain
variable in memory. Providers are polled in parallel with each other. An
endpoint hands the collected values out so a client can draw them.

Nothing here is durable and nothing is pushed. The values live in memory, a
value may be absent when it has never been read or could not be read, and
clients poll the endpoint when they want to know.

## What done looks like

- `asyncLock` and `asyncQueue` exist as composable lowercase functions with an
  asynchronous `runInLock`, and the rest of the product uses them instead of
  ad-hoc promise chaining or semaphores.
- Both delays exist, and the aborting one throws an abort exception that is
  consistently handled or rethrown.
- `backoff` is infinite by default and honours an abort signal; `retry` is a
  time-bounded backoff that throws on exhaustion; `forever` loops a backoff
  with a delay until shutdown and carries a name.
- Graceful shutdown is a named map of asynchronous handlers that the daemon
  awaits, and slow shutdowns can be attributed to a name.
- Every provider's usage is polled on its own named `forever` every fifteen
  minutes, held in memory with its capture time, and served by an endpoint that
  clients poll.
