# Master plan 8: Persistence

## Big picture

The `persistence` folder holds semantic database operations built from
lower-level SQL queries. These operations may call one another, but every
operation must leave the database consistent. A file must never define only a
partial operation that can leave the database in an invalid state. This is a
practical, non-negotiable rule: otherwise someone will eventually insert one
piece without another and corrupt the database.

Persistence owns reads as well as mutations. Every database read is a
persistence operation prefixed with `query`, such as `queryAgentSessions`,
`querySessions`, or `queryOldSessions`. No SQL may appear outside persistence
files, whether it is raw SQL or expressed through a typed query builder or ORM.

## Operations and transactions

Every operation receives `tx`, the common facade for database work. It is the
ORM database or transaction object — whether that is Drizzle, Prisma, or
something else does not matter — because both expose the same operations. One
runs outside a transaction and the other inside one.

An operation that is consistent by itself, such as a plain create or upsert,
does not need to start a transaction. It can run against either kind of `tx`,
so it also composes inside another operation.

An operation that needs a transaction calls `inTx` with its current `tx` and
receives a `tx` to use. If the current object is already a transaction, this
is a no-op and the same object is used. Otherwise `inTx` starts a transaction.
Each small operation therefore contains its own complete consistency boundary
while remaining easy to read, understand, and compose.

## SQLite

Rig uses synchronous SQLite. Persistence operations are synchronous too.
Synchronous code is much simpler, and SQLite is sufficient for an embedded
server. Supporting multiple database engines, including Postgres, is not a
goal.

## In-memory models

On top of persistence operations, Rig has models, such as a `Session` model.
A model holds its state in memory and synchronizes it according to its own
logic.

The order is always database first, memory second. A model first attempts the
database operation, with a transaction where needed, and only after that
succeeds does it synchronously update its in-memory state. It must be
impossible to change memory first and then fail to persist the change.

## Database failures

Rig is local, so a database query failure brings down the whole system. This
applies whether the failure appears technical or not; continuing after a
database error is not an option.

## What done looks like

- Every persistence operation is a complete consistency boundary and can call
  other operations without weakening that guarantee.
- Database reads are persistence operations named with the `query` prefix, and
  no raw or typed SQL exists outside persistence files.
- Every operation works through `tx`, and `inTx` starts a transaction only
  when one is not already active.
- Persistence uses synchronous SQLite rather than an asynchronous or
  multi-engine abstraction.
- Models persist changes before updating their in-memory state.
- Any database query failure terminates the system.