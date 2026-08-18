# Projects — learnings

Feedback and decisions gathered while building this module.

## A page always shows something

A page that cannot fit one complete row within the output budget used to be an error. A legal folder
path is up to 4,096 characters, longer than the smallest configurable budget of 256, so that turned
an ordinary maximum-length project into a list nobody could read. `fitProjectPage` keeps the first
row and lets the formatter truncate it, so the person always has a row and an ID to act on.

## Equality is canonical everywhere, including the store

`sameJson` is the module's equality, and the store must use it too. Comparing avatars and settings
with `JSON.stringify` made property order alone look like a change: the same settings written with
their keys in another order bumped the version, and the catalog check in `ProjectsModule` then
refused the write because the store's `changed` disagreed with the canonical comparison.

## One home project, enforced at registration

The home directory is the single `home` project, but nothing stopped a second folder from being
registered as `home`. Registration now refuses it, in `create` and in `ensure` alike. Ensuring the
folder that already is the home project still converges on that row.

## Looking at a folder is not always needed

`resolveRemoteName` and `resolveDefaultBranch` decide from what is already stored before they need
a machine — a name a person chose, or a trunk already recorded, is an answer on its own. They only
ask for compute once they really have to inspect the folder, so a catalog built without compute
still answers them.

## The post-commit boundary is the caller's transaction

Post-commit observers are registered against the context the caller handed the module, not the
module's own transaction context. A mutation that runs inside somebody else's larger write then
publishes when that write commits, rather than when the module's inner transaction does.

## Storage values are checked, not coerced

A stored flag is 0 or 1. `Number(value) !== 0` turned a corrupt `2` into a confident `true`; a
value this catalog never wrote is refused instead.

## Order keys should be fractional, not dense positions

Today an order key is the row's position, zero-padded (`orderKeyForPosition`), so one drag renumbers
every row it jumped and `writeGuardedProjectOrder` moves those keys without bumping their versions.
A client that keeps its catalog from the event feed hears only about the row someone dragged: the
rows it jumped still hold their old keys, two projects claim one position, the tie breaks on id, and
the dragged row is drawn straight back where it started. The daemon is right and the drag is lost
anyway. The reorder route now announces every project the transaction moved, which makes the feed
truthful, but the neighbours are still unversioned writes.

Rig before the module rewrite had no such problem: `projectReorder` wrote exactly one row with a key
from `orderKeyAfter` / `generateKeyBetween` — vendored fractional indexing, still sitting unused at
`packages/rig/sources/utils/fractionalIndexing.ts`. A move touched one row, bumped one version, and
produced one event that told the whole truth. Reordering should go back to that: a fractional key
between the two neighbours the row lands amongst, one guarded write, no whole-list rewrite.

## A remote port is digits

The remote URL pattern accepted `https://github.com:bad/repo`, a URL no clone can resolve. The host
may carry a port, and a port is digits.

## Detached background work must restore its database

The catalog's background work runs on a lifetime detached from the first caller. Detaching removes
the agent database deliberately, so a transaction facade cannot escape the transaction that owns
it. The module keeps the underlying database separately and restores it with `withAgentDatabase`
before background work writes.

## Construction names only module dependencies

The catalog takes `ConfigModule` and `GitModule`, not an options object or loose collaborators.
Configuration owns its durable paths and credentials; Git owns repository operations. The catalog
mints IDs and timestamps itself, keeps page bounds as constants, and accepts event subscribers
after construction through `onEventTransactional` and `onEvent`.

## Sibling vocabulary crosses through the module

A sibling may import the project module class and public types from `index.ts`, but not project
helpers or internals. Rules another feature needs—validating names and client IDs, normalizing base
references, deriving storage keys, and reducing Git facts—are public methods on `ProjectsModule`,
so the owning module remains the single source of that behavior.
