# Projects — learnings

Feedback and decisions that the spec does not yet state, gathered while implementing it.

## A page always shows something

§13 says a page that cannot show one complete row within the output budget is an error. A legal
folder path is up to 4,096 characters, which is longer than the smallest configurable budget of
256, so that rule turns an ordinary maximum-length project into a list that cannot be read at all.
`fitProjectPage` now keeps the first row and lets the formatter truncate it, so the person always
has a row and an ID to act on. **Proposed spec change:** the budget trims a page, and the first row
is kept even when it must be truncated.

## Equality is canonical everywhere, including the store

`sameJson` is the module's equality, and the store must use it too. Comparing avatars and settings
with `JSON.stringify` made property order alone look like a change: the same settings written with
their keys in another order bumped the version, and the catalog check in `ProjectsModule` then
refused the write because the store's `changed` disagreed with the canonical comparison.

## One home project, enforced at registration

§2 says the home directory is the single `home` project, but nothing stopped a second folder from
being registered as `home`. Registration now refuses it, in `create` and in `ensure` alike. Ensuring
the folder that already is the home project still converges on that row.

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

## A remote port is digits

The remote URL pattern accepted `https://github.com:bad/repo`, a URL no clone can resolve. The host
may carry a port, and a port is digits.
