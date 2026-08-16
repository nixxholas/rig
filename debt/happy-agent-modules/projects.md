# Module report: projects

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/projects/`, the v2 rewrite of
Rig's project surface (`packages/rig/sources/project/` and
`packages/rig/sources/tools/workspaces/workspaceTools.ts` are the v1 reference implementation being
replaced), read against root `AGENTS.md` and master plans 00, 03 (workspaces and Git), 16, 18, 20,
21. Note: the master plans still name `@slopus/happy-agent-features` and have not yet been updated
for the rewrite into `happy-agent-modules`.

## Summary

The module is a provider-neutral catalog of `{ id, ownerAgentId, repositoryRef, name, status,
description, timestamps }` rows plus a per-project recursive-JSON settings blob, exposed as eight
model tools. It deliberately knows nothing about paths, Git, or the filesystem — the repository
reference is an opaque string. That purity is the rewrite's main design decision and also its main
cost: the validation v1 performed at registration is gone, so a project that is not tied to a real
repository is a row the agent can invent, and the new settings surface has no defined meaning.

## Changes from the Rig v1 implementation

- **Regression — registration is no longer validated.** v1's `add_project`
  (`workspaceTools.ts:308-335`) takes an absolute path, and `ProjectRepository` validates it as "a
  readable canonical Git top-level" before import, is idempotent by canonical path, and "restores an
  archived project instead of creating another entity" (`rig/sources/project/README.md:26-31`). v2's
  `create_project` accepts any string matching `^[^\u0000\r\n]+$` up to 2,048 characters
  (`projectRepositoryRefSchema`, `Project.ts:38-42`) and writes a row. Nothing checks that the
  repository exists. Some of this follows from the deliberate host-neutral boundary, but the
  existence and idempotency guarantees v1 gave are not replaced by anything.
- **Regression — Auto-review posture on mutations.** v1's `add_project` sets
  `requiresAutoOrFullAccess: true`, `shouldReviewInAutoMode: () => true`, and a
  `describeAutoPermissionAction` naming the path it will inspect and register
  (`workspaceTools.ts:327-330`), because registration reads the host filesystem outside the
  workspace. v2's `create_project`, `ensure_project`, `rename_project` and `archive_project` all set
  `shouldReviewInAutoMode: () => false` (`tools/create_project.ts:18`, `tools/ensure_project.ts:16`,
  `tools/rename_project.ts:19`, `tools/archive_project.ts:21`). For a pure catalog write that is
  arguably defensible; but the module's own `archive_project` description says archival triggers
  "host folder or Git cleanup" as an independent concern (`tools/archive_project.ts:16`), i.e. the
  unreviewed tool call is what causes a host to delete a folder. The v1 baseline reviewed the
  weaker of those two actions.
- **New capability without plan backing.** v1's model-facing project surface is exactly
  `list_projects` and `add_project`. `rename_project` and the settings pair are new in the rewrite.
  v1 does have `ProjectSettings` in its protocol (`rig/sources/project/ProjectRepository.ts`
  imports), but as a client/daemon concern, not a model tool; promoting it to a model tool needs a
  plan decision rather than a port decision.
- **New capability — `update_project_settings` is a general-purpose agent-writable key-value store.**
  `projectSettingsSchema` (`Project.ts:126`) is arbitrary recursive JSON up to depth 8, 64 properties
  and 64 items per level, 4 KiB strings, 16 KiB encoded. The tool replaces the whole blob
  (`tools/update_project_settings.ts:17`). Nothing defines what a setting *is*, who reads it, or what
  effect writing one has. This is scratch storage handed to a model with a project-shaped name.
- **Deliberate improvement — archival semantics.** Master plan 03 is clear that archiving is "an
  immediate, irreversible logical action" and that folder deletion is background cleanup that never
  rolls the decision back. v2 models exactly that (`tools/archive_project.ts:16`) and states it more
  explicitly than the v1 tool description does.

## Findings

1. **Three pairs of byte-identical schemas.** `projectEnsureInputSchema` (`Project.ts:167-174`) and
   `projectEnsureToolInputSchema` (176-183) have the same properties and the same options;
   likewise `projectRenameInputSchema` (185-191) / `projectRenameToolInputSchema` (193-199), and
   `projectSettingsUpdateInputSchema` (209-215) / `projectSettingsUpdateToolInputSchema` (217-223).
   The `*ToolInput` convention exists to strip host-only fields — which it genuinely does for
   `projectCreateInputSchema` vs `projectCreateToolInputSchema` (144-161, `id` removed) — so the
   other three are copies kept for symmetry.
2. **A fourth copy inside the tools.** `archive_project.ts:7-10` and `get_project.ts:12-15` build
   their own local input objects out of `projectIdSchema` rather than importing a shared one, and
   then export them (`archive_project.ts:33`, `get_project.ts:32`), adding two more public names for
   `{ projectId }`.
3. **`ProjectsModule.ts` is 1,551 lines and `ProjectStore.ts` is 661.** AGENTS.md: "A file should
   hold one coherent piece of behavior. Most product code lands at one function per file." Seven
   public formatters plus eight operations plus paging plus authorization plus settings validation
   live in one class.
4. **A custom TypeBox kind is registered to check for a plain object.**
   `projectPlainObjectSchema` (`Project.ts:87-98`) calls `TypeSystem.Type` to register a global type
   named `"ProjectPlainObject"` whose validator inspects `Object.getPrototypeOf`. Registering a
   process-global TypeBox kind from a library module is a side effect on import, and it collides if
   any other module ever registers the same name. `Type.Record` with `additionalProperties` already
   rejects arrays.
5. **The settings schema is expanded eagerly to depth 8.** `projectSettingsValueAtDepth`
   (`Project.ts:109-117`) builds a new `Type.Union` of leaf + array + record at every level, so the
   compiled schema is exponential in `MAX_PROJECT_SETTINGS_DEPTH` and is re-validated in full on
   every read and write. The comment (119-122) explains why a bound is needed but not why the bound
   has to be structural rather than a depth check during traversal.
6. **`MAX_PROJECT_TIMESTAMP = Number.MAX_SAFE_INTEGER`** (`Project.ts:15`) is a bound in name only;
   `projectTimestampSchema` accepts any non-negative safe integer, so `archivedAt` may precede
   `createdAt` with no complaint.
7. **Detail paging on a row of eight scalar fields.** `get_project` returns a
   `projectDetailPageSchema` with a cursor (`tools/get_project.ts:23`, `ProjectDetailPage.ts`), and
   `get_project_settings` returns a settings page with `nextDetailOffset`
   (`tools/get_project_settings.ts:21`). A project row is at most a few kilobytes and the settings
   blob is capped at 16 KiB; the paging machinery, its cursors, and their model-facing instructions
   ("follow nextDetailOffset until the complete settings stream has been read") cost the model more
   tokens than the data would.
8. **Two names for reading a project, twice.** `get`/`getPage` and `readSettings`/`readSettingsPage`
   plus `listPage`/`list` (README:36-43) repeat the duplicate-public-operation pattern seen in the
   scheduling and secrets modules.
9. **Seven public formatters.** `formatForModel`, `formatPageForModel`, `formatDetailPageForModel`,
   `formatProjectForModel`, `formatProjectOperationForModel`, `formatSettingsForModel`,
   `formatSettingsPageForModel` (README:46-49) are all exported "so a host can render the same
   bounded text" — a host-rendering API with no identified consumer, since the host renders projects
   from its own protocol types.

## What it gets right

`ensure_project` is a genuinely good design and a clear improvement on v1's path-keyed idempotency:
the uniqueness decision is made inside the module's own transaction and the result reports
`created: true/false`, so a repeated call after a crash converges on one row rather than two
(`tools/ensure_project.ts:11`, README:57-59). That is exactly the "one-entity rule" master plan 03
demands of workspace creation, applied to projects, and it is achieved without a receipt or replay
ledger. Archival is modelled as an immediate irreversible logical decision with host cleanup
explicitly outside it, matching plan 03 precisely. Keeping the repository reference opaque is a
defensible boundary: the module genuinely never resolves a path or runs Git, so it cannot leak host
filesystem knowledge into agent state. All tools are durable, all mutations set `transactional: true`
so Agent Base commits the row and the tool result together, and review is never coupled to
Full-access elevation. TypeBox is used throughout with types derived by `Static`, per policy, and the
settings bounds — depth, per-level items and properties, string length, and encoded UTF-8 bytes — are
enumerated rather than hand-waved.
