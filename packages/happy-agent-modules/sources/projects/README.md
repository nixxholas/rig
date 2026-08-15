# Projects

Projects are agent-facing repository catalog rows exposed through one small,
provider-neutral module. The module owns its catalog, settings, and
migrations in the Agent Base database. It never resolves a path, runs Git, or
performs filesystem cleanup; those host operations remain outside the module.

```ts
import { ProjectsModule } from "@slopus/happy-agent-modules";

const projects = new ProjectsModule();
```

## Tools

- `list_projects` lists active or archived projects in bounded cursor pages.
- `get_project` reads one project and its complete, cursor-addressable detail.
- `create_project` registers a repository reference and display name.
- `ensure_project` registers a detected repository exactly once. The module
  decides repository uniqueness inside its transaction and returns
  `{ created: true }` only when it created the row.
- `rename_project` changes a display name.
- `archive_project` records logical archival; host cleanup is independent.
- `get_project_settings` reads bounded recursive JSON settings with detail
  paging.
- `update_project_settings` replaces bounded recursive JSON settings.

All tools are durable and provider-neutral, and all opt out of Auto permission
review. Mutation tools complete with `call.commit` inside the same database
transaction as the catalog or settings change.

## Public API

Every operation receives `(ctx, agentId, ...)`:

- `listPage`/`list` read bounded cursor pages, with `status` and
  `includeArchived` filters.
- `get` reads a project, and `getPage` reads its bounded detail stream.
- `create` registers a repository and name; `ensure` registers a repository
  exactly once and returns `{ project, created }`.
- `rename` changes the display name, and `archive` records logical archival.
- `readSettings` returns the bounded settings record;
  `readSettingsPage` is the detail-paged model-facing form.
- `updateSettings` replaces settings transactionally.

`formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
`formatProjectForModel`, `formatProjectOperationForModel`,
`formatSettingsForModel`, and `formatSettingsPageForModel` are public so a host
can render the same bounded text used by tools.

## Host boundary

The module owns the `projects` and `project_settings` tables through its ordered
Agent Base migrations. Direct host calls may inject an
`AgentStorageTransaction`; module hooks use the database and transaction
carried by their Agent Base scope.

Agent Base owns durable tool-call completion. The module does not maintain a
second receipt, fingerprint, proof, or replay system. Concurrent ensure calls
converge through the catalog transaction and repository uniqueness constraint.

Every changed mutation is represented by one frozen event:
`project_created`, `project_renamed`, `project_archived`, or
`project_settings_updated`. Transactional and post-commit listeners receive the
same event object. Post-commit listener failures are contained and optionally
reported through `onPostCommitError`. Registration uses stdlib
`afterCommit(ctx, ...)`.

Settings are finite recursive JSON. Every level is bounded by explicit
depth/string/item/property limits, and the encoded UTF-8 representation is
bounded before it crosses the store boundary. Authorization defaults to
same-owner access only; a host policy may grant cross-agent reads or actions.
