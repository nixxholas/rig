# Applets

A catalog of small programs an agent can build and hand back to its host. The model points the
module at a folder it produced, and the module verifies that folder and installs it: it copies
the tree onto disk itself, versions it, and keeps the durable metadata in its module-owned database.
Given a path, it verifies and installs to the target directory.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { AppletModule } from "@slopus/happy-agent-modules";

const applets = new AppletModule({ listener });
const agent = await Agent.create(ctx, { ...options, modules: [applets] });
```

The module owns its applet metadata and evidence tables through its ordered Agent Base migration.
`rootDirectory` is where
applets are installed, defaulting to `defaultAppletsRootDirectory()` — `~/Happy/Applets` on macOS
and `~/happy/applets` elsewhere. `listener` is optional and receives `AppletEvent`s. Other
options — `authorFactory`, `idFactory`, `eventIdFactory`, `clock`, the `max*` bounds, and
`onPostCommitError` — have defaults and let a host override identity resolution, output limits, and
post-commit error reporting.

## On-disk layout

One folder per applet, holding its icon and one directory per version:

```
<rootDirectory>/<name>/favicon.png
<rootDirectory>/<name>/favicon.ico
<rootDirectory>/<name>/v1/
<rootDirectory>/<name>/v2/
```

The icon sits beside the version folders rather than inside them, because it identifies the applet
and not any one version of it. `appletIconUrl(name)` gives the stable path a host serves it from.
Which version is current is catalog metadata, not a filesystem link, so a revert moves a pointer
and touches no files.

## Tools it provides to the model

`AppletModule.tools` returns eight tools, all marked `durable: true` and
`shouldReviewInAutoMode: () => false`:

- **`create_applet`** / **`import_applet`** — aliases of the same operation (`appletToolImportInputSchema`:
  `name`, `description`, `purpose`, `path`, optional `iconPath`, `allowedScopes`,
  `sourceDescription`). `path` is an absolute path to a real folder on this machine, and `iconPath`
  an absolute path to a PNG; the module resolves both and refuses anything else. Fails if an
  applet with that `name` already exists. Returns the new `Applet` at version 1.
- **`update_applet`** — imports a new source version for an existing applet and optionally revises
  its metadata (`name`, `path`, `changeDescription`, and optional `allowedScopes`, `description`,
  `purpose`, `sourceDescription`, `iconPath`). Returns the updated `Applet`.
- **`revert_applet`** — sets the current version pointer back to an already-stored `version`
  (`name`, `version`). It does not re-import anything; it only changes which existing version is
  current. Returns the `Applet` at its (possibly unchanged) current version.
- **`remove_applet`** — deletes an applet from the catalog by `name`. Returns `true` if something
  was removed, `false` if it was already absent.
- **`get_applet`** — reads one applet's metadata, current version, and full version list by
  `name`. Returns `{ applet }`, `applet` being `undefined` if not found.
- **`list_applets`** — reads a bounded page of applets (`limit`, `cursor`), returning
  `{ applets, limit, hasMore, nextCursor? }`. The model is told to follow `nextCursor`.
- **`read_applet_asset`** — reads one bounded asset straight out of the installed version folder
  (`name`, `path`, optional `version`, defaulting to the current version). Returns the asset as
  UTF-8 or base64 text, or `undefined`/`null` if not found.

Principles that govern every tool:

- **Idempotency.** Every mutating call (`create`, `update`, `revert`, `remove`) is wrapped by the
  module's own operation identity and receipt machinery (see Storage below), so a retried tool
  call with the same arguments replays the durable result instead of re-running the mutation, and
  a retried call with different arguments is rejected outright.
- **Bounds.** List pages, output text, source imports, and asset reads are all capped
  (`MAX_APPLET_LIST_SIZE`, `maxOutputCharacters`, `maxSourceFiles`/`maxSourceBytes`/
  `maxSourceFileBytes`, `maxAssetBytes`). If a page or asset cannot fit the configured character
  budget, `listPage` narrows the page size until it does rather than truncating an applet identity
  mid-row.
- **What the model sees.** Every tool has a `toLLM` formatter that turns the structured result into
  a short text line built from `formatOperationForModel`, `formatAppletForModel`,
  `formatPageForModel`, `formatRemovalForModel`, or `formatAssetForModel`. These formatters never
  hide an applet's name, version, or a list cursor behind truncation; they throw instead if the
  identity itself cannot fit the output budget, and only truncate trailing description or asset
  content.
- **Permissions.** None of the eight tools request Auto-mode review, even though installing now
  writes real files under `rootDirectory`, which defaults to a folder in the user's home directory
  rather than the workspace.
- **Paging.** `list_applets` cursors are opaque to the module (host-owned), but the module still
  verifies that a non-terminal page always advances the cursor and that a terminal page carries no
  cursor.

## External functions

These are `AppletModule`'s public methods, usable directly by a host or exposed through an API.
Tool-facing variants take an `agentId` and end in `ForAgent`; they resolve the author identity
through `authorFactory` and reuse the same underlying method.

- `import(ctx, input: AppletImportInput): Promise<Applet>` / `create` (alias) — creates a new
  applet. `input.operationId` may be supplied for host-driven idempotency; tools omit it and let
  the module allocate one. Emits an `applet_imported` event.
- `importForAgent(ctx, agentId, input: AppletToolImportInput)` / `createForAgent` (alias) — the
  tool-facing form; resolves `authorSessionId` from `agentId` via `authorFactory`.
- `update(ctx, name, input: AppletUpdateInput): Promise<Applet>` — imports a new version and
  applies any supplied metadata changes. Emits `applet_updated`.
- `updateForAgent(ctx, agentId, name, input: AppletToolUpdateInput)` — tool-facing form.
- `revert(ctx, name, input: AppletRevertInput): Promise<Applet>` — moves the current-version
  pointer to an existing `input.version`. Emits `applet_reverted` (with `previousVersion`) only if
  the pointer actually changed.
- `revertForAgent(ctx, agentId, name, input: AppletToolRevertInput)` — tool-facing form.
- `remove(ctx, name, requestedOperationId?): Promise<boolean>` — removes the applet. Emits
  `applet_removed` only if something existed to remove.
- `removeForAgent(ctx, agentId, name)` — tool-facing form.
- `get(ctx, name): Promise<Applet | undefined>` — reads one applet by name.
- `list(ctx, query?: AppletListQuery): Promise<readonly Applet[])` — the applets from one page.
- `listPage(ctx, query?: AppletListQuery): Promise<AppletListPage>` — the full page, including
  `hasMore`/`nextCursor`.
- `current(ctx, agentId, name): Promise<AppletVersion | undefined>` — the authoritative current
  version row, cross-checked against `catalog.current` and the applet's own version list.
- `readAsset(ctx, input: AppletAssetReadInput): Promise<AppletAsset | undefined>` — reads one
  bounded asset, defaulting to the applet's current version.
- `formatForModel`, `formatPageForModel`, `formatAppletForModel`, `formatOperationForModel`,
  `formatRemovalForModel`, `formatAssetForModel` — the same text formatters the tools use,
  available to a host that wants identical output outside a tool call.

Every mutating method (`import`/`create`, `update`, `revert`, `remove`) runs inside the module-owned
database transaction and, on success, calls the listener's `onEventTransactional` inside that same
transaction, then `onEvent` after the outer commit through stdlib `afterCommit(ctx, callback)`.
Files are staged before the transaction opens and committed by an atomic rename registered through
the same post-commit scope, so durable metadata and the installed directory move together.

## Storage

Durable metadata and mutation evidence live in the module-owned applet tables; installed files
belong to the module:

- **The applet row** (`Applet`, from `Applet.ts`): `name`, `description`, `purpose`,
  `authorSessionId`, `allowedScopes`, optional `sourceDescription`/`iconThumbhash`/`iconUrl`,
  `currentVersion`, `versions` (an `AppletVersion[]` — `version`, `changeDescription`, `createdAt`,
  `operationId` — capped at `MAX_APPLET_VERSIONS` = 100), `createdAt`, `updatedAt`. Owned and
  persisted entirely by the module's direct database helper.
- **Mutation receipts** (`AppletCatalogMutationReceipt`, keyed by `operationId` via
  direct database reads/writes): `operation`, `name`, `operationId`, `fingerprint`,
  `beforeExists`, `beforeCurrentVersion`, and the full `result` envelope. This is the replay record
  a repeated call with the same `operationId` reads back instead of re-mutating the catalog.
- **Mutation proofs** (`AppletCatalogMutationProof`, keyed by `operationId` via
  direct database reads/writes): an append-only duplicate of the
  same fields as the receipt. The module cross-checks proof against receipt on every replay and
  rejects a mismatch, so a tampered or partially-written receipt cannot silently short-circuit a
  mutation.
- **Operation identities** (`AppletOperationReceipt` — `{ id, fingerprint }`), stored in the
  agent's call-scoped `AgentKV` (from `@slopus/happy-agent-base`, resolved via `agentKV(ctx)`)
  under one of the fixed keys `"import"`, `"update"`, `"revert"`, `"remove"`. When a tool omits
  `operationId`, the module allocates one through `idFactory` and stores it under that key inside
  the current call's KV transaction; a second execute against the same call scope with the same
  argument fingerprint reuses that identity, and one with a different fingerprint throws. If no
  `AgentKV` is attached to the context, the module falls back to allocating a fresh operation ID
  every call (no replay protection).
- **The installed files**, owned by the module itself. An import copies the source tree into a
  hidden staging directory next to its target (`copyAppletTree`), and the transaction ends by
  renaming that directory into place — a single atomic step, so a half-copied version is never
  visible as a version. If the catalog transaction rolls back, the staging directory is removed and
  any directory moved aside is renamed back. A post-commit failure rolls the stage back and reports
  through `onPostCommitError` rather than failing an already-committed mutation.
  Copying is bounded by `maxSourceFiles`, `maxSourceBytes` and `maxSourceFileBytes` (capped by
  `MAX_APPLET_SOURCE_FILES` = 10,000, `MAX_APPLET_SOURCE_BYTES` = 50 MiB,
  `MAX_APPLET_SOURCE_FILE_BYTES` = 10 MiB), and refuses symbolic links, special files, and anything
  that is not a regular file. Files are opened with `O_NOFOLLOW`, so swapping a regular file for a
  symlink after it was checked cannot escape the tree.
- **The icon**: `stageAppletIcon` requires an absolute path to a regular, non-symlink PNG no larger
  than `MAX_APPLET_ICON_BYTES` = 4 MiB, and writes it as both `favicon.png` and `favicon.ico`. The
  package has no image-decoding dependency, so it validates and repackages the PNG rather than
  resizing it, masking it, or deriving a thumbhash.
- **Assets**: read on demand by `readAppletAssetFile` from the version folder, bounded by
  `maxAssetBytes` (capped at `MAX_APPLET_ASSET_BYTES` = 2 MiB). Only a known static-web extension is
  served; an unknown one reads as missing rather than being sniffed. Traversal, backslashes, NUL
  bytes and dotfiles are refused, and a resolved symlink may not leave the version folder. Nothing
  about an asset is retained after the call returns.

Validation is layered: every value crossing the catalog boundary — applet rows, pages, mutation
results, receipts, and proofs — plus every asset the module reads back off disk is checked against
its TypeBox schema and then against module-owned structural invariants (`assertApplet`,
`assertAppletPage`, `assertAppletMutation`, `assertAppletMutationReceipt`,
`assertAppletMutationProof`, `assertAppletAsset`) before the module trusts it:
contiguous, uniquely-numbered versions starting at 1, timestamps that stay inside the applet's
lifetime and only move forward, a `currentVersion` that names a real version, and mutation results
whose `name`/`targetVersion`/`currentVersion` agree with the applet they claim to describe. Retention
of receipts, proofs, and versions beyond `MAX_APPLET_VERSIONS` is entirely the host catalog's
policy; the module enforces only the upper bound on how many versions and list items it will
accept in a single response.
