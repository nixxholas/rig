# Applets

`AppletModule` installs bounded source folders as versioned applets. It owns the installed files
and stores the applet catalog in its module database.

```ts
import { AppletModule } from "@slopus/happy-agent-modules";

const applets = new AppletModule({ rootDirectory });
```

The default root is `~/Happy/Applets` on macOS and `~/happy/applets` elsewhere. Each applet uses
this layout:

```text
<root>/<name>/favicon.png
<root>/<name>/favicon.ico
<root>/<name>/v1/
<root>/<name>/v2/
```

The current version is catalog metadata. Reverting changes that pointer without deleting or
copying a version.

## Tools

The module provides:

- `create_applet` and `import_applet`
- `list_applets` and `get_applet`
- `update_applet` and `revert_applet`
- `remove_applet`
- `read_applet_asset`

Create, import, update, and remove cross both database and filesystem boundaries, so their tools
are non-durable. They use Agent Base's stable cuid2 `call.id` as the ordinary operation identity
recorded in version history, but the module does not maintain replay receipts, proofs,
fingerprints, or call-scoped operation state.

Revert changes only catalog state. Its tool is durable and sets `transactional: true`, so Agent
Base wraps execution, result validation, rendering, catalog writes, and result completion in one
transaction.

Read tools remain safely repeatable. Every tool has a fixed Auto permission predicate and bounded
model-facing output.

## Transactions and events

Each catalog mutation uses `ctx.inTx(...)`, which reuses an Agent Base transaction already carried
by the context or opens one otherwise. Every database operation reads the active facade from
`ctx.db`. `onEventTransactional` runs inside that transaction. `onEvent` runs after it commits.

Imports and updates copy the source into a hidden staging directory. The staged directory is moved
into place after the catalog transaction commits; rollback removes the stage. Removal deletes the
installed directory after the catalog deletion commits.

The `001-applets-catalog` migration is immutable and may create the historical receipt and proof
tables. The append-only `002-remove-applet-idempotency` migration drops those obsolete tables.
Runtime code does not read or write them.

## Public operations

Direct callers can use `import`/`create`, `update`, `revert`, `remove`, `get`, `list`,
`listPage`, `current`, and `readAsset`. Mutation inputs may supply `operationId`; otherwise the
module creates an ID. This value is history identity only and does not make a repeated request a
replay. Repeating a conflicting operation is handled as an ordinary conflict.

Tool-facing create, import, update, remove, and revert methods receive `call.id` from their tool
definitions. Agent Base commits the revert result when the transactional tool returns.

## Bounds and validation

Source copies enforce file-count, total-byte, and per-file byte limits. Symbolic links and special
files are rejected. Asset reads enforce a byte limit, reject traversal, and return UTF-8 or base64
content only for supported static-web extensions.

All catalog inputs and outputs use TypeBox schemas. Additional invariants require contiguous
versions starting at 1, unique version history operation IDs, ordered timestamps, a real current
version, and mutation envelopes that match the applet they describe.