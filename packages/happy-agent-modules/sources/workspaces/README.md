# Workspaces

A workspace is one place a session actually works: a branch, a folder, a base it came from, and a
lifecycle that says whether it is usable yet. The module owns that catalog and its migrations in the
Agent Base database, and it owns the _decisions_ — which name, which branch, which folder key, which
status. It never runs Git. A host does the worktree and filesystem work and reports back through
narrow optional hooks.

The important consequence is ordering: the durable reservation happens **first**, and Git happens
after. A workspace row exists, with a unique name, storage key, and branch, before anything touches
the disk. That is what makes creation collision-safe across concurrent sessions and what makes a
crashed creation recoverable rather than a half-made worktree nobody recorded.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { WorkspacesModule } from "@slopus/happy-agent-modules";

const workspaces = new WorkspacesModule({ host: hostWorkspaceOperations });
const agent = await Agent.create(ctx, { ...options, modules: [workspaces] });
```

`host` holds only Git and filesystem concerns: `pathForStorageKey`, `isBranchUnavailable`,
`isStorageKeyUnavailable`, `renameBranch`, `archive`, `branchMetadata`, and `transfer`. The first
three are how a reservation finds out what is already taken, and `reserve` refuses to run without
them: they must come from the host or from the caller's hooks, and either may answer asynchronously.
The rest are optional, and when one is absent the module falls back to its own catalog behaviour.
`cleanupContext` is the lifetime folder removal runs on, and is **required** whenever `host.archive`
is configured, because archival hands cleanup to that lifetime instead of the caller's.
`authorization` lets one agent act on another agent's workspaces (self access is always allowed
without it); `idFactory`, `eventIdFactory`, and `clock` let a host control identity and time instead
of `crypto.randomUUID()` and `Date.now()`; `listener` receives every workspace event; `maxPageSize`
and `maxOutputCharacters` bound paging and model-facing text; `onPostCommitError` is told about a
listener failure after the durable transaction has already committed; `onHostError` is told when a
host archive or branch rename throws, so the durable record can stand while the host problem is
still surfaced.

## The record

Every field below is present on every row. `branch`, `storageKey`, `path`, and `kind` are mandatory
in the schema _and_ `NOT NULL` in the table, because software downstream of this module now depends
on a workspace being able to answer "which branch?" and "which folder?" without a null check.

| Field                                                            | Meaning                                                                                                                                                                |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `ownerAgentId`, `projectRef`                               | Identity and ownership.                                                                                                                                                |
| `name`, `nameConfigured`                                         | Display name, and whether a person chose it. An inherited name may be replaced silently; a configured one may not.                                                     |
| `branch`                                                         | The Git branch, mandatory. Derived as `worktree/<kebab-name>` unless a caller supplies one.                                                                            |
| `storageKey`                                                     | The kebab-case folder key, mandatory and unique within the project.                                                                                                    |
| `kind`                                                           | `"git_worktree"` or `"directory"`.                                                                                                                                     |
| `path`                                                           | The absolute filesystem path, mandatory and globally unique.                                                                                                           |
| `baseRef`, `baseCommit`                                          | What the workspace was cut from, and the exact commit if known.                                                                                                        |
| `gitCommonDir`                                                   | The shared `.git` directory a worktree belongs to, for cleanup.                                                                                                        |
| `presence`                                                       | `"present"` or `"missing"` — whether the folder is still on disk. A reservation starts `missing`, because the durable row is written before anything touches the disk. |
| `status`                                                         | `initializing`, `ready`, `failed`, `archiving`, or `archived`. There is no `active`.                                                                                   |
| `orderKey`                                                       | A fractional order key; lexicographic order is list order. New reservations lead the list.                                                                             |
| `version`                                                        | An integer bumped on every durable change, and the token for optimistic concurrency.                                                                                   |
| `creatorSessionId`                                               | The session that asked for it, if any.                                                                                                                                 |
| `gitAhead`, `gitBehind`, `gitDetached`, `gitHead`, `gitUpstream` | Host-reported Git facts.                                                                                                                                               |
| `initializationAttempt`, `initializationError`                   | How many times setup has been tried, and why the last try failed.                                                                                                      |
| `createdAt`, `updatedAt`, `archivedAt`                           | Timestamps; `updatedAt` is forced to advance on every change.                                                                                                          |

## Lifecycle

`reserve` → host builds the worktree → `recordInitialization` (path, commit, common dir) →
`markReady`. If setup fails, `markInitializationFailed` records the error and raises
`initializationAttempt` so a retry is distinguishable from the first try; `markFailed` is the
terminal form. `applyGitFacts` and `applyProbe` fold in what the host observes later — `applyProbe`
is ignored unless the workspace is ready, so a probe racing initialization cannot resurrect a row,
and both are ignored once the workspace is archived, because an observation that was already in
flight describes a workspace nobody has any more.

Archival is two steps on purpose. `beginArchive` is the durable decision and moves the row to
`archiving` immediately, and that is what `archive` returns. Host cleanup does **not** run in the
caller's lifetime: it is started on `cleanupContext` and `completeArchive` moves the row to
`archived` when it finishes. A tool call therefore returns as soon as the decision is durable,
however long a folder takes to delete. If cleanup throws, the workspace stays `archiving` and the
failure is reported through `onHostError` — **cleanup failure never rolls archival back**. A person
who archived a workspace does not get it handed back because a folder would not delete.
`whenCleanupSettles()` waits for the removals this module started, for shutdown and for tests.

## Tools it provides to the model

- **`create_workspace`** — `{ projectRef, name, baseRef? }`. Reserves one workspace owned by the
  calling agent. `projectRef` is required: a workspace belongs to a project, and there is no
  fallback project to put an unclaimed one in. The tool passes its call ID as the operation ID, so
  a retried call after a crash resolves to the same workspace rather than a second one. The input stays minimal on purpose: `name` is a title a person would recognise,
  not a slug or a path, and the module derives the storage key and branch from it.
- **`rename_workspace`** — `{ workspaceId, name }`. Renames an owned workspace, marks the name as
  configured, and moves the branch with it when the host can.
- **`list_workspaces`** — `{ projectRef?, includeArchived?, cursor?, limit? }`. A page of the
  calling agent's workspaces in list order, capped at `maxPageSize` (100 by default). Archived
  workspaces are history and are left out unless `includeArchived` is passed.
- **`get_workspace`** — `{ workspaceId, cursor?, limit? }`. One workspace rendered as a bounded
  detail string, paged so a small output budget cannot silently drop identity or lifecycle fields.
- **`transfer_workspace`** — `{ targetWorkspaceId }`. Asks the host to move the current
  agent/session into an existing workspace. The result says whether the move happened
  (`transferred`) or was deferred (`scheduled`).
- **`archive_workspace`** — `{ workspaceId }`. Archives one workspace, with the two-step semantics
  above.
- **`get_workspace_branch_metadata`** — `{ workspaceId, cursor?, limit? }`. Host-reported Git facts,
  paged the same way.

There is deliberately no model tool for `recordInitialization`, `markReady`, `markFailed`,
`markInitializationFailed`, `setBranch`, `inheritName`, `reorder`, `beginArchive`,
`completeArchive`, `applyGitFacts`, or `applyProbe`. Those are host lifecycle transitions driven by
what Git actually did; a model guessing at them would be inventing state.

Governing principles across all seven tools:

- Read, create, and rename tools use `shouldReviewInAutoMode: () => false`. Archive and transfer use
  `shouldReviewInAutoMode: () => true` and disclose their destructive host-side effects to the Auto
  reviewer. Neither declares `shouldRunInFullAccessInAutoMode`; review does not grant unsandboxed
  execution.
- `create_workspace`, `rename_workspace`, and `archive_workspace` are durable transactional tools.
  `transfer_workspace` is non-durable because it crosses the host boundary and that external effect
  cannot be committed atomically. The three read tools are non-durable because a current read does
  not need replay.
- Every result the store returns is re-validated against its schema and cross-checked against a
  fresh authoritative read before it is trusted. The store's `changed` flag must agree with an
  actual before/after comparison, and a changed row must have advanced its `version`; a mismatch
  throws rather than passing bad state to the model.
- Every page and detail string is re-clipped to `maxOutputCharacters`, never truncated silently.
- Ownership is enforced on every read and mutation: acting on another agent's workspace is refused
  unless the host's `authorization` callback allows the specific action.

### Paging

One convention across all three paged reads: pass `cursor` and `limit` in, receive `cursor`,
`nextCursor`, and `total` back. `cursor` is an integer offset. This replaces the three different
conventions the module used to carry (`cursor`/`nextCursor`, `detailOffset`/`nextDetailOffset`, and
an opaque string cursor).

## External functions

All methods take `(ctx, agentId, ...)` and live on `WorkspacesModule`, one instance per host wiring
— `agentId` is passed explicitly on every call, not bound to the instance.

Creation and naming:

- `reserve(ctx, agentId, input, hooks?): Promise<{ created, workspace }>` — collision-safe
  reservation. `input` requires `projectRef`, and its `path`, when given, must be an absolute
  normalized path. `hooks` carries the caller's predicates (`isBranchUnavailable`,
  `isStorageKeyUnavailable`, `pathForStorageKey`) separately because functions cannot be
  structured-cloned; all three must be answerable, from hooks or host, or the reservation refuses.
  A reservation with no explicit `id` takes its identity from `operationId`, so a tool call retried
  after a crash reserves the same workspace. `created` is the store's authoritative flag, so
  replaying the same workspace ID returns `created: false` with the same row. A replay that
  describes different work — another project, a different base or base commit, a different kind,
  common directory, name or storage seed, a different owner or creator session — is refused instead
  of quietly rewriting the reservation. Losing the race for a name is not an error: the module
  re-picks from a fresh snapshot rather than surfacing a uniqueness conflict.
- `rename(ctx, agentId, input): Promise<Workspace>` — takes an optional `expectedVersion` and
  refuses a stale rename. Sets `nameConfigured: true`.
- `inheritName(ctx, agentId, input): Promise<Workspace>` — replaces the name only while
  `nameConfigured` is false.
- `setBranch(ctx, agentId, input): Promise<Workspace>` — records the branch Git actually ended on.

Lifecycle:

- `recordInitialization`, `markReady`, `markFailed`, `markInitializationFailed`, `applyGitFacts`,
  `applyProbe` — each returns the authoritative `Workspace`.
- `beginArchive`, `completeArchive`, and `archive` — the last commits the decision, starts host
  cleanup on `cleanupContext`, and returns the `archiving` row without waiting for it.
  `whenCleanupSettles()` waits for those removals.
- `reorder(ctx, agentId, input)` — `{ workspaceId, afterId, expectedVersion? }`; `afterId: null`
  moves a workspace to the top.

Reading:

- `listPage(ctx, agentId, query?)` and `list(ctx, agentId, query?)` — active workspaces only
  unless `includeArchived: true` is passed.
- `get(ctx, agentId, workspaceId)`, `getByPath(ctx, agentId, path)`, and
  `getPage(ctx, agentId, workspaceId, query?)` — `getPage` returns `{ workspace: null }` for an
  unknown ID instead of throwing.
- `transfer(ctx, agentId, input)` — also accepts a project-transfer shape
  (`{ workspaceId, targetProjectRef, operationId? }`) that the model tool does not expose.
- `branchMetadata` and `branchMetadataPage`.
- `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
  `formatWorkspaceOperationForModel`, `formatWorkspaceForModel`,
  `formatBranchMetadataDetailPageForModel`, `formatBranchMetadataForModel` — the exact rendering
  each tool's `toLLM` uses, exposed so a host can show the same text outside a tool call.

Naming helpers are exported too: `workspaceNameKey`, `workspaceStorageKey`, and
`workspaceBranchName` derive the collision key, the kebab folder key, and the `worktree/<key>`
branch. Collisions are suffixed the way a person would expect — `Name (2)` for names, `key-2` for
keys and branches.

## Events

Every changed mutation emits a `WorkspaceEvent`: `workspace_created`, `workspace_updated` (carrying
a `change` naming the transition), `workspace_renamed`, `workspace_reordered` (with
`previousOrderKey`), `workspace_transferred`, `workspace_archived`, or
`workspace_transfer_scheduled`. Each carries `eventId`, `at` (from `clock`), `agentId`, and the
resulting workspace. If `listener.onEventTransactional` is set it runs inside the same store
transaction as the mutation; `listener.onEvent` runs only after that transaction has durably
committed, receiving the identical frozen event object. A listener failure is reported to
`onPostCommitError` and otherwise swallowed — it never fails the mutation that already happened.

## Storage

The module owns `happy_agent_module_workspaces` through its ordered Agent Base migrations.
Migration `004-workspace-git-record` drops and recreates the table rather than migrating it column
by column: a workspace is now a branch, a folder, a base, and a lifecycle instead of an opaque
catalog row, and the old rows could not describe a real worktree anyway. Rig is early stage, so
that trade is the honest one. Unique indexes cover `path`, `(project_ref, branch)`,
`(project_ref, storage_key)`, and `(project_ref, name_key)`; listing is ordered by
`(project_ref, order_key, id)`.

Every runtime database operation uses `ctx.db`; direct multi-step mutations use `ctx.inTx`.
Post-commit notification uses stdlib `afterCommit(ctx, ...)`. Each mutation is one
read-decide-write-reconcile transaction, and Agent Base owns transactional tool completion.
