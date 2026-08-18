# Projects — learnings

Feedback and decisions gathered while building this module.

## A page always shows something

A page that cannot fit one complete row within the output budget used to be an error. A legal folder
path is up to 4,096 characters, longer than the smallest configurable budget of 256, so that turned
an ordinary maximum-length project into a list nobody could read. `fitProjectPage` keeps the first
row and lets the formatter truncate it, so the person always has a row and an ID to act on.

## Equality is canonical everywhere, including the store

`sameJson` is the module's equality, and the store must use it too. Comparing settings with
`JSON.stringify` made property order alone look like a change: the same settings written with their
keys in another order bumped the version, and the catalog check in `ProjectsModule` then refused
the write because the store's `changed` disagreed with the canonical comparison. Avatar equality
also includes the normalized image's content hash, not only its public metadata.

## Avatar metadata and bytes are one change

Keeping only an avatar description on the project while writing its bytes to an independent file
allowed the row, event, and image to disagree. A project now durably exposes only the API-shaped
`{ kind: "image", source, thumbhash }`, while its normalized WebP and integrity metadata live in a
project-owned table. Set and clear update both inside the project mutation transaction, and their
events carry the exact previous project, so every response, event, restart, and GET sees one image.

## One home project, enforced at registration

The home directory is the single `home` project, but nothing stopped a second folder from being
registered as `home`. Registration now refuses it, in `create` and in `ensure` alike. Ensuring the
folder that already is the home project still converges on that row.

## No Git is a project kind, not a registration error

A project is a folder, so requiring every explicitly registered folder to be a Git repository
rejected the plain-directory workflow the workspace model already supports. Registration now
accepts a readable ordinary directory while still rejecting a subdirectory inside a Git working
tree. Setup durably records Git as absent, marks worktrees unsupported with a human reason, and the
workspaces module consequently creates copied child folders without another compatibility path.

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

Dense positional keys made one drag rewrite every row it crossed without versioning or announcing
those neighbour changes. Event-driven clients then retained duplicate positions and could draw the
moved row back where it started.

Project and root-agent ordering now use decimal fractional keys. A reorder computes one key between
the destination neighbours, guards and versions only the moved resource, and emits one event that
tells the whole truth. Neighbour rows remain byte-for-byte unchanged.

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

## Embedded agent lists are resource changes

Project and workspace API resources include their ordered root-agent lists. Writing only an
association row made that visible resource change without advancing the owner's version or emitting
its update, so a client could retain a stale catalog under a current-looking version. A real
attach, move, or reorder now changes the association, advances every affected owner's version, and
emits the exact previous and current owner snapshots in one transaction. Repeated attachment and a
no-op reorder leave both the association and owner untouched.
