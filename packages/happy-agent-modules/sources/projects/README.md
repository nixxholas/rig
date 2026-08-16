# Projects

Projects are agent-facing repository catalog rows exposed through one small,
provider-neutral module. The module owns its catalog, settings, ordering,
avatar metadata, and migrations in the Agent Base database. It never resolves
a path, runs Git, or performs filesystem cleanup; those host operations remain
outside the module.

```ts
import { ProjectsModule } from "@slopus/happy-agent-modules";

const projects = new ProjectsModule({});
```

## Tools

- `list_projects` lists projects in their independent main-list order in
  bounded cursor pages.
- `get_project` reads one project and its complete, cursor-addressable detail.
- `create_project` registers a repository reference and display name.
- `ensure_project` registers a detected repository exactly once and restores
  its archived row when one already exists. It returns `{ created: true }` only
  when it created the row.
- `rename_project` changes a display name with an optional `expectedVersion`
  guard.
- `archive_project` records logical archival; host cleanup is independent.
- `unarchive_project` restores logical archival.
- `reorder_project` moves a project in the independent main project list.
- `set_project_avatar` stores normalized, bounded avatar metadata.
- `clear_project_avatar` removes avatar metadata; host-owned bytes remain a
  host concern.
- `get_project_settings` reads bounded recursive JSON settings with detail
  paging.
- `update_project_settings` replaces bounded recursive JSON settings with an
  optional `expectedVersion` guard and returns the current project version.

All tools are durable and provider-neutral, and all opt out of Auto permission
review. Mutation tools set `transactional: true`; Agent Base commits their
returned result with the catalog or settings change.

## Public API

Every operation receives `(ctx, agentId, ...)`:

- `listPage`/`list` read bounded cursor pages, with `status` and
  `includeArchived` filters.
- `get` reads a project, and `getPage` reads its bounded detail stream.
- `create` registers a repository and name; `ensure` registers a repository
  exactly once and returns `{ project, created }`.
- `rename` changes the display name with optimistic concurrency protection,
  and `archive` records logical archival.
- `unarchive` restores an archived project, `reorder` changes the main-list
  order, and `setAvatar`/`clearAvatar` manage normalized avatar metadata.
- `avatarAsset` reads bounded normalized bytes through the optional host
  `ProjectAvatarAssetReader`; it returns `undefined` when no reader is
  supplied.
- `readSettings` returns the bounded settings record;
  `readSettingsPage` is the detail-paged model-facing form.
- `updateSettings` replaces settings transactionally and accepts an optional
  expected project version.

`formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
`formatProjectForModel`, `formatProjectOperationForModel`,
`formatSettingsForModel`, and `formatSettingsPageForModel` are public so a host
can render the same bounded text used by tools.

## Host boundary

The module owns the `projects` and `project_settings` tables through its ordered
Agent Base migrations. Migration `003-project-order-version-avatar` adds the
durable `orderKey`, optimistic-concurrency `version`, and avatar metadata
columns without changing an earlier migration. Database operations use
`ctx.db`, and multi-step mutations compose with `ctx.inTx(...)`.

Agent Base owns durable tool-call completion. The module does not maintain a
second receipt, fingerprint, proof, or replay system. Concurrent ensure calls
converge through the catalog transaction and repository uniqueness constraint.

Every changed mutation is represented by one frozen event:
`project_created`, `project_renamed`, `project_archived`,
`project_unarchived`, `project_reordered`, `project_avatar_updated`,
`project_avatar_cleared`, or `project_settings_updated`. Transactional and
post-commit listeners receive the same event object. Post-commit listener
failures are contained and optionally reported through `onPostCommitError`.
Registration uses stdlib `afterCommit(ctx, ...)`.

Settings are finite recursive JSON. Every level is bounded by explicit
depth/string/item/property limits, and the encoded UTF-8 representation is
bounded before it crosses the store boundary. Authorization defaults to
same-owner access only; a host policy may grant cross-agent reads or actions.
The avatar byte reader is an optional host boundary: it receives `(ctx,
agentId, hash)` and must return a bounded `{ bytes, hash, mediaType }` asset or
`undefined`. The module resolves the owning catalog row and applies the
normal same-owner authorization before invoking it. Missing readers degrade to
metadata-only avatar support.
