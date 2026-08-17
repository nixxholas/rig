# Projects — the catalog of folders an agent works in

This document specifies how the `projects` module works: what a project is, what the catalog
stores about it, who is allowed to change it, and what every durable write is checked against
before anything is told about it. The implementation is `sources/projects/`.

## 1. What the module is for

A project is a folder. The module is the catalog of the folders an agent works in: what each one
is called, whether it is on disk, how far its setup got, and what Git last said about it. It owns
the rows, their settings, their order, their avatar metadata, and its own migrations in the Agent
Base database.

It never resolves a path, runs Git, clones a repository, or deletes anything. A host does that
work and reports the result back here. Every fact in a row is therefore either a decision someone
made through the catalog or an observation a host handed it.

The module name is `"projects"`. It contributes twelve tools and four migrations, and keeps no
state outside its two tables.

## 2. Identity is the folder

`repositoryRef` is the project. It is the canonical absolute folder path — not an opaque
handle — and it is `UNIQUE` in the table: exactly one project per folder.

The schema enforces the shape rather than trusting the caller: an absolute POSIX path or a
Windows drive path, no repeated separator, no `.` or `..` component, no trailing separator, no
control character. A path the host has not already canonicalized is not something this catalog
can key on, so it is refused at the boundary instead of stored and disbelieved later.

Two further identities hang off the row:

- `id` — the durable catalog identity, minted by the configurable `idFactory`
  (`crypto.randomUUID()` by default). Tool input never carries it on creation.
- `storageKey` — a portable kebab-case key, also `UNIQUE`, derived from the display name by
  folding accents away and turning every non-alphanumeric run into a separator. A collision gets
  the smallest free `-2`, `-3` suffix. Hosts build managed project and workspace directories from
  it, so it must stay filesystem-safe on every target; the base is capped at 48 characters to
  leave room for that suffix, and a name that reduces to nothing becomes `project`.

`kind` is `"home"` or `"regular"`. The home directory is the single `home` project: always named
`Home`, storage key `home`, always `ready`, never initialized.

## 3. What a row holds

| Field | Meaning |
| --- | --- |
| `presence` | `present` or `missing` — whether the folder is on disk |
| `initializationStatus` | `initializing`, `ready`, or `failed` |
| `initializationAttempt` | how many attempts have been made, saturating at 1,000,000 |
| `initializationError` | a bounded readable message, present **only** while `failed` |
| `nameSource` | `folder`, `user`, or `remote` |
| `defaultBranch` | the trunk workspaces are cut from; decided once |
| `worktreeSupport` | `supported`, `unsupported`, or `unknown` |
| `worktreeUnsupportedReason` | present **only** while `unsupported` |
| `remoteSource` | `{kind:"github", repository}` or `{kind:"git", url}` for a folder still to be cloned |
| `requiredSecretKind` | the credential kind a retry needs — never the secret itself |
| `gitAhead`/`gitBehind`/`gitDetached`/`gitBranch`/`gitHead`/`gitUpstream` | the last Git facts a host reported |
| `status`, `orderKey`, `version`, `avatar`, `description` | catalog state |
| `createdAt`, `updatedAt`, `archivedAt` | timestamps |

Three of these are worth stating as rules rather than fields.

**A name a person chose is never overwritten.** `nameSource` exists for exactly this: a
folder-derived name may later be replaced by the remote repository's name, but once someone
renames a project the source becomes `user` and `adoptRemoteName` stops applying to it.

**A remote URL that could only fail later is refused now.** A `git` remote must be HTTPS, must
have a host, and must not embed credentials — the only shape the clone boundary will actually
run. Accepting a URL the clone would reject creates a project that can never finish being set up.

**Git facts are a cache.** The module never derives them; it only records what a host observed.

Timestamps are bounded by a real date (1 January 2200) rather than `Number.MAX_SAFE_INTEGER`,
because a timestamp past that is a bug and not a date. `archivedAt` can never precede `createdAt`
or follow `updatedAt`, and an active project must not have one at all.

Every human-readable field forbids control characters, written as explicit code-point ranges
because a JSON Schema `pattern` compiles without the `u` flag — `\p{Cc}` there would match the
letter `p`. Git refs are validated against what `git check-ref-format` accepts.

## 4. Settings

Settings are a small closed object, not free-form JSON: an optional `defaultWorkspaceCompute` of
`{type:"local"}` or `{type:"docker", image}`. Every field has a defined meaning and a reader on
the host side, so anything else is rejected. An empty object means "use the host default".

Settings live in their own table keyed by project ID. A settings row is created empty alongside
every new project, and a settings read for a project that exists but has no row returns `{}`
rather than failing.

## 5. Every durable write takes one path

`ProjectMutations.run` is the single path, and it runs inside one `ctx.inTx`:

1. **Read the before-row** — by ID, or by folder for `ensure`, or not at all for `create`.
2. **Authorize** the acting agent against the row's `ownerAgentId` for this specific action.
3. **Run the store operation**, which decides and writes.
4. **Validate the answer against storage.** The result must name the acting agent, must carry a
   project, and that project must be byte-identical to what a fresh read of the row returns. A
   store that reports something it did not write is caught here, not believed.
5. **Check the transition** (§6).
6. **Emit exactly one event** — but only when something actually changed.

Reads are checked too: a store that returns a project under the wrong ID, or a folder lookup that
comes back with a different folder, is an error rather than a result. Everything handed out is
`structuredClone`d, so a caller cannot mutate the catalog by holding onto what it was given.

`updateSettings` composes its own transaction because it spans two tables, but performs the same
sequence: read, authorize, write, reread, compare, and emit only on a real change.

## 6. What a transition is allowed to do

`assertProjectTransition` is where the catalog states its own rules about change.

- **Immutable forever**: `id`, `ownerAgentId`, `repositoryRef`, `kind`, `storageKey`,
  `createdAt`. No operation rewrites what a project *is*.
- **Named per operation**: every mutation declares the fields it may touch, and a field that
  moved outside that set is an error. A rename may move `name` and `nameSource`; a reorder may
  move `orderKey`; a lifecycle write may move only the fifteen host-reported state fields.
- **`version` and `updatedAt`** are always allowed to move.
- **A changed row advances `version` by exactly one** and never moves `updatedAt` backwards.
- **An unchanged row is byte-identical.** Equality uses a canonical JSON encoding with sorted keys
  and `undefined` entries dropped, so property order cannot fake a change and a re-encoded row
  cannot fake an unchanged one.

Beyond the transition, `assertProjectRecord` holds for every row however it was written: ordered
timestamps, archival consistency, the home project always `ready`, an initialization error only
on a failed project, and a worktree reason only on an unsupported one.

## 7. Guarded writes and refusal

Every mutating statement carries its own `WHERE version = <the version it was read at>` and ends
in `RETURNING id`. `writeGuardedProject` then requires that exactly one row came back, that it is
the intended row, and that a reread shows the version advanced by exactly one. A write that
touched nothing means something else moved the row first, and the caller is told so rather than
handed a result it did not cause.

Callers may also pass `expectedVersion`; the mutation refuses up front when the stored version is
not the one the caller was looking at. This is optimistic concurrency for a person acting on a
stale view, distinct from the internal guard, which protects against a concurrent writer.

**Reordering is one transaction over the whole list.** The catalog is read in order, the moved
project is spliced into its new position, and every row whose position changed is rewritten —
each guarded by the version it was read at. A catalog that moved underneath is refused whole,
rather than left half in the new order and half in the old. Only the project someone actually
moved counts as changed and takes a version bump; its neighbours merely sit somewhere else, so
`writeGuardedProjectOrder` moves their `order_key` without touching their version. Placing a
project after itself is an error.

Order keys are 20-digit zero-padded decimal strings, dense from position 1. A new project takes
the highest existing key plus one.

## 8. Registration, and converging on one row

`create` registers a folder that nothing knows about yet. It refuses a folder that is already a
project — pointing the caller at `ensure_project` — and refuses a duplicate ID.

`ensure` is the idempotent path a host uses when it has just resolved a working directory:

- No row for that folder → create one, `created: true`, `changed: true`.
- An active row → return it untouched, `created: false`, `changed: false`. No version bump, no
  event.
- An archived row → bring it back to active, `created: false`, `changed: true`, emitting
  `project_restored`. An archived project becomes active again rather than becoming a second row
  for the same folder.

Concurrent `ensure` calls converge through the catalog transaction and the folder uniqueness
constraint. The module keeps no receipt, fingerprint, proof, or replay table of its own; Agent
Base owns durable tool-call completion, and migration `002` dropped the tables an earlier design
used for it.

A new row starts `active`, attempt `0`, worktree support `unknown`, no Git facts. Its `presence`
is `missing` when a remote still has to be cloned and `present` otherwise, and its
`initializationStatus` is `ready` for the home project and `initializing` for everything else.

## 9. Lifecycle: what a host reports

Every lifecycle operation is a host telling the catalog what it observed or did. They all funnel
through one internal `#changeState`, emit one `project_state_changed` event carrying the reason,
and share one rule: **write only when something actually changed.**

| Operation | What it records | When it does nothing |
| --- | --- | --- |
| `applyProbe` | presence, worktree support, optionally Git facts | — |
| `applyGitFacts` | branch, head, upstream, divergence | — |
| `setDefaultBranch` | the trunk | a default branch is already recorded |
| `adoptRemoteName` | the remote's name | `nameSource` is not `folder` |
| `markCloneReady` | the folder now exists | the project is not `initializing` |
| `markInitializationReady` | setup succeeded | the project is not `initializing` |
| `markInitializationFailed` | setup failed, with a bounded reason | the project is not `initializing` |
| `retryInitialization` | back to `initializing` | the project is not `failed` |
| `refresh` | back to `initializing` for another attempt | the project is `home` |

When the observation matches what is already stored, or a guard says the change does not apply,
the operation returns the existing row untouched: no version bump, no event, no listener call.

**Archival is the terminal decision.** A clone result, a probe, a setup outcome, or a refresh that
was already in flight when a project was archived describes a project nobody has any more, and
changes nothing about it. `#changeState` drops the computed change entirely for an archived row.
`restore` is how a project comes back, and it does not go through this path.

`setDefaultBranch` being decided once is deliberate: a project that later sits on another branch
must not silently start forking workspaces from somewhere else.

## 10. Events

Every changed mutation produces exactly one frozen event: `project_created`, `project_renamed`
(carrying `previousName`), `project_archived`, `project_restored`, `project_reordered` (carrying
`previousOrderKey`), `project_avatar_updated`, `project_avatar_cleared`,
`project_settings_updated`, or `project_state_changed` (carrying the reason the lifecycle moved).

Each event is schema-checked and deep-frozen before anyone sees it, and the same object goes to
both listeners:

- `onEventTransactional` runs **inside** the transaction, so a listener that throws prevents the
  change from committing.
- `onEvent` runs through stdlib `afterCommit`, so it only ever sees durable state. It cannot undo
  a committed change: a failure is contained and optionally reported through `onPostCommitError`,
  with a bounded message, and a reporter that itself throws is ignored, because observer reporting
  is advisory once durable state has settled.

Probe, Git, and initialization updates all carry the whole project, which is why they are one
event type with a stated reason rather than nine event types: the listener contract stays small.

## 11. Authorization

An agent always reaches its own records. Anything else is a denial unless the host installed a
policy that allows that exact `(actingAgent, ownerAgent, action)` combination — a missing policy
is an answer, not an absence of one. A policy returning anything but a boolean is an error.

The action vocabulary is explicit: `list`, `get`, `ensure`, `create`, `rename`, `archive`,
`restore`, `reorder`, `set_avatar`, `clear_avatar`, `avatar_update`, `avatar_read`,
`settings_read`, `settings_update`, `update_state`. `list` is authorized **per row**, so a page
never mixes in a project the caller may not see.

## 12. Tools

Twelve tools, all `durable`, all provider-neutral. Every mutation tool is also `transactional`, so
Agent Base commits its returned result together with the catalog or settings change.

`list_projects`, `get_project`, `get_project_settings` read. `create_project`, `ensure_project`,
`rename_project`, `archive_project`, `restore_project`, `reorder_project`, `set_project_avatar`,
`clear_project_avatar`, `update_project_settings` write.

`create_project` takes only the folder, a display name, and an optional description: the durable
identity and the internal `kind`/`nameSource`/`remoteSource` fields are host concerns and are
omitted from the model-facing schema.

**`archive_project` is the one tool that reviews in Auto mode.** Not because of its own write —
that never leaves the database — but because archival is what sets host cleanup in motion.
`describeAutoPermissionAction` says so plainly: the project's managed folder and every workspace
worktree cut from it will be deleted, and archival stands even if that cleanup fails. Review is
not elevation; the tool does not ask for Full access, because nothing it does needs it.

## 13. Reading, paging, and model output

`list` returns the projects someone can still work in. Archived rows are history and appear only
with `includeArchived: true` or an explicit `status`. Ordering is `(orderKey, id)`.

Paging reads one row past the limit, so a page that ends exactly on the limit does not offer a
cursor onto nothing. Cursors are decimal offsets, bounded to 16 characters and parsed as safe
non-negative integers. The module independently verifies each page it is handed: no more rows
than requested, strictly increasing `(orderKey, id)`, no archived row that was not asked for, no
row outside a requested status, no cursor on an empty page, and a cursor that advances by exactly
the number of visible rows.

The page is then fitted to the model-output budget: rows are added while the text plus its
continuation line fits, and the cursor is rewritten so the caller resumes exactly where the
visible rows stopped. A page that cannot show even one complete row within the budget is an
error rather than a silently empty answer.

All model-facing text is written out in plain English rather than as stored identifiers — "Still
being set up", "This project cannot create Git worktrees: …", "New workspaces run in Docker using
the *image* image". `formatProjectForModel`, `formatPageForModel`, and `formatSettingsForModel`
are public so a host renders exactly the same text the tools do. Over-long text is truncated with
an ellipsis.

## 14. Avatars

The row stores avatar **metadata** only: a 64-hex content hash, `image/webp`, pixel dimensions, a
source (`repository`, `hosting`, `user`), and a URL. `clear_project_avatar` removes that
metadata; the bytes behind it stay a host concern.

The bytes are reachable through the optional `avatarAssetReader` host bridge. `avatarAsset`
resolves the owning row by hash first, applies the normal same-owner authorization, and only then
calls the reader. It then re-validates what came back: the hash must be the one asked for, the
media type must be `image/webp`, and the bytes must be within 8 MiB. A reader that returns an
unrelated asset is an error. With no reader configured, avatar support degrades to metadata only
and asset reads return `undefined` — the catalog stays useful either way.

## 15. Storage

The module owns two tables, `happy_agent_module_projects` and
`happy_agent_module_project_settings`, through four ordered Agent Base migrations. The names are
stable and human-readable so an upgrade can append migrations without borrowing Rig's application
schema. Database work goes through `ctx.db`; multi-step mutations compose with `ctx.inTx`.

| Migration | What it does |
| --- | --- |
| `001-projects-catalog` | the original catalog, settings, and the receipt/proof tables |
| `002-drop-project-idempotency-tables` | drops receipts and proofs — Agent Base owns durable completion |
| `003-project-order-version-avatar` | adds `order_key`, `version`, `avatar_json`, backfills order from `rowid` |
| `004-project-folder-record` | **drops and recreates both tables** as the folder record |

`004` is destructive on purpose. A project became a real folder with a kind, a storage key,
presence, initialization state, and cached Git facts; an opaque repository reference cannot be
turned into a canonical folder path, and inventing one would put unusable rows in front of a
person. Rig is early-stage, so the old rows go rather than being migrated column by column.

An existing migration is never edited afterwards: a released Rig may already have applied it.

`repository_ref` and `storage_key` are `UNIQUE`; `repository_ref`, `kind`, `storage_key`,
`presence`, and `initialization_status` are `NOT NULL`. Indexes cover `(status, id)` and
`(order_key, id)`. Every value read back out of SQLite is re-validated against the schema before
it is treated as a project — a row that storage cannot produce validly is an error, not a
best-effort object.

## 16. Bounds

| Bound | Value |
| --- | --- |
| Folder path | 4,096 chars |
| Project ID / agent ID | 96 chars |
| Storage key | 64 chars (48 before a collision suffix) |
| Display name | 500 chars |
| Description | 2,000 chars |
| Error detail | 500 chars |
| Git ref | 512 chars |
| Git divergence | 1,000,000 |
| Initialization attempts | 1,000,000 |
| Order key | 128 chars, 20 digits in practice |
| Avatar hash | 64 hex chars |
| Avatar URL | 2,048 chars |
| Avatar dimension | 16,384 px |
| Avatar bytes | 8 MiB |
| Remote URL | 2,048 chars |
| Docker image | 512 chars |
| Timestamp | ≤ 1 January 2200 |
| Page size | 100 max, 50 default |
| Cursor | 16 chars |
| Model output | 12,000 chars default, 256–100,000 configurable |

## 17. Public surface

Reads: `list`, `get`, `getByPath`, `readSettings`, `avatarAsset`.

Registration and catalog edits: `create`, `ensure`, `rename`, `archive`, `restore`, `reorder`,
`setAvatar`, `clearAvatar`, `updateSettings` — each accepting an optional `expectedVersion`
where a stale view is possible.

Lifecycle: `applyProbe`, `applyGitFacts`, `setDefaultBranch`, `adoptRemoteName`, `markCloneReady`,
`markInitializationReady`, `markInitializationFailed`, `retryInitialization`, `refresh`.

Formatting: `formatProjectForModel`, `formatPageForModel`, `formatSettingsForModel`.

Every operation takes `(ctx, agentId, …)`. Construction takes optional `authorization`,
`avatarAssetReader`, `idFactory`, `eventIdFactory`, `clock`, `listener`, `maxPageSize`,
`maxOutputCharacters`, and `onPostCommitError`; `new ProjectsModule({})` is valid and gives a
fully working catalog. A store is never injected — the SQLite adapter is module-owned, and
`projectStoreSchema` remains exported only for the protocol package's structural types.

## 18. Invariants to preserve

- One project per canonical folder path. The path is the identity, and the schema — not a
  caller's promise — decides what a path is.
- `id`, `ownerAgentId`, `repositoryRef`, `kind`, `storageKey`, and `createdAt` never change.
- A changed row advances its version by exactly one; an unchanged row is byte-identical and
  produces no event.
- Every operation may touch only the fields it declared, and every guarded write must land on
  exactly the row it was decided against, at exactly the version it was read at.
- A reorder is all-or-nothing across the whole list.
- A name a person chose is never replaced by a folder- or remote-derived one.
- The default branch is decided once.
- Archival is terminal: in-flight lifecycle reports change nothing about an archived project, and
  only `restore` brings one back.
- The home project is always named `Home` and always `ready`.
- No secret material is ever stored on a project row — only the kind of credential a retry needs.
- Git facts are recorded, never derived.
- A missing authorization policy denies cross-agent access; it never defaults to allowing it.
- Post-commit listeners cannot undo a committed change, and transactional listeners are the only
  ones that can prevent one.
- The module keeps no second receipt, fingerprint, proof, or replay system; Agent Base owns
  durable tool-call completion.
