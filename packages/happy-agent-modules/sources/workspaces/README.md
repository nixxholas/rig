# Workspaces

Isolated places to work — checkouts, worktrees, or whatever a host makes of a project and a base
ref — that an agent can create, list, inspect, move a session into, rename, and archive without
knowing anything about Git or filesystem operations. The module owns its catalog and migrations in
the Agent Base database. Host Git, filesystem, and process operations remain behind narrow optional
services. A host may report the workspace's bounded filesystem `path`, and may return
`initializing` or `archiving` records while provisioning or cleanup continues asynchronously.

Catalog-only mutation tools use Agent Base's stable cuid2 call ID and declare
`transactional: true`. Transfers cross into the host, retain `call.id` as their operation
identity, and are non-durable because that external effect cannot be committed atomically.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { WorkspacesModule } from "@slopus/happy-agent-modules";

const workspaces = new WorkspacesModule({ host: hostWorkspaceOperations });
const agent = await Agent.create(ctx, { ...options, modules: [workspaces] });
```

`host` is optional and contains only Git/filesystem operations such as creation, archival, renaming,
branch metadata, and transfers. Each lifecycle hook is optional: when absent, the module's catalog
fallback remains available. `authorization` lets one agent act on another agent's
workspaces (self access is always allowed without it); `idFactory`, `eventIdFactory`, and `clock`
let a host control identity and time generation instead of using `crypto.randomUUID()` and
`Date.now()`; `listener` receives every workspace event; `maxPageSize` and `maxOutputCharacters`
bound paging and model-facing text; `onPostCommitError` is told about a listener failure after the
durable transaction has already committed.

## Tools it provides to the model

- **`create_workspace`** — `{ projectRef?, name, baseRef? }`. Creates one workspace owned by the
  calling agent. `projectRef` and `baseRef` are opaque strings the host interprets; `name` is
  required. Agent Base commits the result with the catalog change.
- **`list_workspaces`** — `{ projectRef?, includeArchived?, cursor?, limit? }`. Lists a page of the
  calling agent's workspaces, including archived and archiving rows by default. Set
  `includeArchived: false` to restrict the page to active rows. Pages are capped at `maxPageSize`
  (100 by default). `cursor` is an opaque decimal offset returned as `nextCursor`; passing it back
  continues from exactly where the last page ended.
- **`get_workspace`** — `{ workspaceId, detailOffset?, detailLimit? }`. Reads one workspace by ID.
  The full record is rendered as a bounded detail string and paged with `detailOffset`/
  `detailLimit` (up to 1,024 characters per page) so a small model-output budget cannot silently
  drop project, ownership, or timestamp fields; the model follows `nextDetailOffset` to read the
  rest.
- **`transfer_workspace`** — `{ targetWorkspaceId }`. Asks the host to move the current
  agent/session into an existing workspace. The result is `{ state: "scheduled", ... }` if the
  host defers the move, or `{ state: "transferred", workspace, ... }` once it has happened; the
  model is told which.
- **`archive_workspace`** — `{ workspaceId }`. Archives one workspace. Archiving is the durable
  decision recorded by the store; any worktree or folder cleanup the host performs afterward is
  its own, asynchronous concern.
- **`get_workspace_branch_metadata`** — `{ workspaceId, detailOffset?, detailLimit? }`. Reads
  host-reported Git facts (branch, head, upstream, ahead/behind, detached) for a workspace, paged
  the same way as `get_workspace`. The module never runs Git; it only validates and pages what the
  store returns.

Governing principles across all six tools:

- Read and create tools use `shouldReviewInAutoMode: () => false`. Archive and transfer use
  `shouldReviewInAutoMode: () => true` and describe their destructive host-side effects to the
  Auto reviewer. Neither tool declares `shouldRunInFullAccessInAutoMode`; review does not grant
  unsandboxed execution.
- `create_workspace` and `archive_workspace` are durable transactional tools.
  `transfer_workspace` is non-durable because it crosses the host boundary. The three read tools
  are non-durable because a current catalog or Git read does not need replay.
- Every result the store returns is re-validated against its schema and cross-checked against a
  fresh authoritative read (`store.get`) before it is trusted; a mismatch throws rather than
  passing bad state to the model.
- List and detail pages are always re-clipped to `maxOutputCharacters` before reaching the model,
  never truncated silently — `formatForModel`/`formatPageForModel`/`formatDetailPageForModel` throw
  rather than drop a record's identity fields.
- Ownership is enforced on every read and mutation: an agent acting on another agent's workspace is
  refused unless the host's `authorization` callback allows the specific action (`list`, `get`,
  `branch_metadata`, or `transfer`).

## External functions

All methods take `(ctx, agentId, ...)` and are exported on `WorkspacesModule`, one instance per
host wiring (not per agent — `agentId` is passed explicitly on every call):

- `create(ctx, agentId, input: WorkspaceCreateInput): Promise<Workspace>` — the host-facing form of
  `create_workspace`. `input` may include `id` and `operationId` directly; direct callers that omit
  them receive fresh IDs from the configured `idFactory`.
- `listPage(ctx, agentId, query?: WorkspacePageQuery): Promise<WorkspacePage>` and
  `list(ctx, agentId, query?): Promise<Workspace[]>` — the latter is `listPage` with just the
  `workspaces` array.
- `get(ctx, agentId, workspaceId): Promise<Workspace | undefined>` — one full, unpaged workspace
  record.
- `getPage(ctx, agentId, workspaceId, query?: WorkspaceDetailQuery): Promise<WorkspaceDetailPage>` —
  the host-facing form of `get_workspace`'s bounded detail paging; returns `{ workspace: null }` for
  an unknown ID instead of throwing.
- `transfer(ctx, agentId, input: WorkspaceTransferInput): Promise<WorkspaceTransferResult>` — also
  accepts a project-transfer shape (`{ workspaceId, targetProjectRef, operationId? }`) that
  `transfer_workspace` does not expose to the model, for hosts that move a workspace between
  projects directly.
- `archive(ctx, agentId, workspaceId, options?: WorkspaceArchiveOptions): Promise<Workspace>`.
- `rename(ctx, agentId, input: WorkspaceRenameInput): Promise<Workspace>` — renames an owned
  workspace while preserving its opaque project, path, and lifecycle fields. A host rename hook may
  also move its external branch or folder before returning the authoritative row.
- `branchMetadata` / `getBranchMetadata(ctx, agentId, workspaceId): Promise<WorkspaceBranchMetadata>`
  and `branchMetadataPage` / `getBranchMetadataPage(ctx, agentId, workspaceId, query?)` — the paged
  form backs `get_workspace_branch_metadata`.
- `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
  `formatWorkspaceOperationForModel`, `formatWorkspaceForModel`,
  `formatBranchMetadataDetailPageForModel`, `formatBranchMetadataForModel` — the exact rendering
  each tool's `toLLM` uses, exposed so a host can show a model (or a person) the same text outside a
  tool call.

Every changed mutation (`create`, `rename`, `transfer`, `archive`) emits a `WorkspaceEvent` —
`workspace_created`, `workspace_renamed`, `workspace_transferred`, `workspace_archived`, or
`workspace_transfer_scheduled` — carrying `eventId`, `at` (from `clock`), `agentId`, and the
resulting workspace (or, for a scheduled transfer, the target ID). If `listener.onEventTransactional`
is set it runs inside the same store transaction as the mutation; `listener.onEvent` runs only
after that transaction has durably committed, receiving the identical frozen event object. A
listener failure is reported to `onPostCommitError` and otherwise swallowed — it never fails the
mutation that already happened.

## Storage

The module owns the `workspaces` table through its ordered Agent Base migrations. Forward-only
migrations remove the obsolete workspace receipt and proof tables and add the optional host path.
Every runtime database operation uses `ctx.db`; direct multi-step mutations use `ctx.inTx`.
Post-commit notification uses stdlib `afterCommit(ctx, ...)`.

Each catalog mutation performs one read-decide-write-reconcile transaction. Agent Base owns
transactional tool completion.
