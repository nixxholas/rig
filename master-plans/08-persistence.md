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

Every asynchronous operation receives `ctx` as its first argument. The context
carries the common facade for database work in `ctx.tx`. It is the ORM database
or transaction object — whether that is Drizzle, Prisma, or something else does
not matter — because both expose the same operations. One runs outside a
transaction and the other inside one. A store owns its database resource, but
never retains a caller context: each operation derives the caller's context
with that store's database installed.

An operation that is consistent by itself, such as a plain create or upsert,
does not need to start a transaction. It reads either kind of facade from
`ctx.tx`, so it also composes inside another operation.

An operation that needs a transaction awaits `inTx` with its current `ctx` and
receives a derived `ctx` whose `ctx.tx` is the transaction. If the current
context already carries a transaction, this is a no-op and the same transaction
is used. Otherwise `inTx` acquires the database lock and starts a transaction.
Each small operation therefore contains its own complete consistency boundary
while remaining easy to read, understand, and compose.

## SQLite

Rig contains only asynchronous SQLite code, and every persistence operation is
asynchronous. There is no synchronous SQLite implementation or archive tree.
All access to a database connection, including reads and transactions, runs
through its `asyncLock` so only one operation owns that connection at a time.
Work already inside a transaction composes through its `ctx.tx` without
attempting to acquire the lock again. Supporting multiple database engines, including
Postgres, is not a goal.

### Asynchronous SQLite surface map

| Surface                | Required contract                                                                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session database       | One lifecycle owner holds the libSQL client, Drizzle facade, `asyncLock`, transaction ownership, and awaited close boundary. Plain work acquires the lock; an active owned transaction is reused only inside its async context.                                               |
| Persistence operations | Every semantic read and mutation accepts `ctx` first, reads the shared database scope from `ctx.tx`, and returns a promise. SQL and Drizzle schema access stay inside `persistence/`.                                                                                         |
| Models and stores      | Session, project, folder, document, sharing, Happy, HTTP, and daemon callsites await persistence. Multi-model mutations use one transaction, restore memory on rollback, and defer irreversible runtime or filesystem work until commit.                                      |
| Migrations             | `migrations/` is the single canonical history and contains only async migrations. There is no separate synchronous, archived, or counterpart migration tree. Once released, a migration's number, order, and SQL are immutable; every later schema change is a new migration. |
| Murmur sharing store   | The libSQL-backed store serializes operations and transactions through its own `asyncLock`, drains admitted work before close, and rejects work admitted after closing begins.                                                                                                |
| Gym and scripts        | Database inspection and mutation helpers use the same asynchronous driver, await transactions and close, and fail the script when database work fails.                                                                                                                        |
| Packaging              | The async SQLite driver is a runtime dependency and build external. Native synchronous SQLite rebuilds, types, install allowlists, and deployment assumptions do not remain.                                                                                                  |

## In-memory models

On top of persistence operations, Rig has models, such as a `Session` model.
A model holds its state in memory and synchronizes it according to its own
logic.

The order is always database first, memory second. A model first attempts the
database operation, with a transaction where needed, and only after that
succeeds does it update its in-memory state. The model awaits persistence
before changing memory. It must be impossible to change memory first and then
fail to persist the change.

## Database failures

Rig is local, so a database query failure brings down the whole system. This
applies whether the failure appears technical or not; continuing after a
database error is not an option.

## What done looks like

- Every persistence operation is a complete consistency boundary and can call
  other operations without weakening that guarantee.
- Database reads are persistence operations named with the `query` prefix, and
  no raw or typed SQL exists outside persistence files.
- Every operation receives `ctx` first and works through `ctx.tx`; `inTx`
  derives a transaction context and starts a transaction only when one is not
  already active.
- Persistence uses asynchronous SQLite, and every operation is awaited.
- `migrations/` is the only migration history; it is async, and released
  migration numbers, order, and SQL never change.
- Each database connection uses `asyncLock` for exclusive access, while
  transaction-scoped operations reuse their current `ctx.tx` without
  reacquiring the lock.
- Models persist changes before updating their in-memory state.
- Any database query failure terminates the system.
