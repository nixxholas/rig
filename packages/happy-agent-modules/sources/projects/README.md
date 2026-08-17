# Projects

A project is a folder. This module is the catalog of the folders an agent
works in: what each one is called, whether it is on disk, how far its setup
got, and what Git last said about it. The module owns those rows, their
settings, their order, their avatar metadata and its own migrations in the
Agent Base database. It never resolves a path, runs Git, clones a repository
or deletes anything; a host does that work and reports the result back here.

```ts
import { ProjectsModule } from "@slopus/happy-agent-modules";

const projects = new ProjectsModule({});
```

## The record

`repositoryRef` is the project. It is the canonical absolute folder path, not
an opaque handle, and it is unique across the catalog: one row per folder. The
schema enforces that shape: an absolute path with no `.` or `..` segment and no
control characters, because a path the host has not normalized is not a folder
this catalog can key on.

- `kind` is `"home"` or `"regular"`. The home directory is the single `home`
  project, always named `Home`, always `ready`; nothing initializes it.
- `storageKey` is a portable kebab-case key, unique across the catalog, for
  the directories a host manages on the project's behalf.
- `presence` is `"present"` or `"missing"` — whether the folder is on disk.
- `initializationStatus` is `"initializing"`, `"ready"` or `"failed"`, with
  `initializationAttempt` counting the attempts and `initializationError`
  holding a bounded message that exists only while the status is `failed`.
- `nameSource` is `"folder"`, `"user"` or `"remote"`. A folder-derived name
  may be replaced by the remote's name; a name a person chose never is.
- `defaultBranch` is the trunk workspaces are cut from. It is decided once.
- `worktreeSupport` is `"supported"`, `"unsupported"` or `"unknown"`, with
  `worktreeUnsupportedReason` set only when it is `unsupported`.
- `remoteSource` is `{ kind: "github", repository }` or `{ kind: "git", url }`
  for a project that still has to be cloned, and `requiredSecretKind` names
  the credential kind a retry needs. No secret material is stored here — and
  the `git` URL must be one a clone would actually run: HTTPS, with a host, and
  with no credentials embedded in it, so a URL that could only fail later is
  refused when it is recorded instead.
- `gitAhead`, `gitBehind`, `gitDetached`, `gitBranch`, `gitHead` and
  `gitUpstream` are the last Git facts a host reported. They are a cache, and
  the module never derives them itself.

Alongside those sit `status`, `orderKey`, `version`, `avatar`, `description`
and the `createdAt`/`updatedAt`/`archivedAt` timestamps. Timestamps are
bounded by a real date rather than `Number.MAX_SAFE_INTEGER`, and `archivedAt`
can never precede `createdAt`.

Settings are a bounded object, not arbitrary JSON: an optional
`defaultWorkspaceCompute` of `{ type: "local" }` or
`{ type: "docker", image }`. Anything else is rejected.

## Tools

One tool, `list_projects`, which lists projects in their independent main-list
order in bounded cursor pages. It is durable and provider-neutral, and it never
reviews in Auto mode.

Registering, renaming, archiving, reordering, and the avatar and settings
writes are the host's to make through the public API below; a model changes the
catalog only by asking the person.

The tool exists only when both are true:

- `crossWorkspace` is on. The catalog spans every project on the machine, so
  reading it is exactly what looking outside the current project means, and the
  user's `features.cross_workspace` setting decides whether it is offered.
- The agent is somebody's own conversation. A subagent works inside the task it
  was handed and is given no view of the catalog.

When the tool is absent, a model has no project tools at all rather than a tool
that fails when it is called.

## Public API

Every operation receives `(ctx, agentId, ...)`. Each one that changes a row
bumps `version` and emits exactly one frozen event.

Reads:

- `list` returns a bounded page of the projects someone can still work in;
  archived rows are history and appear only with `includeArchived: true`. A page
  that ended exactly on the last row returns no `nextCursor`.
- `get` reads by ID, `getByPath` reads by canonical folder path.
- `readSettings` returns the bounded settings record.
- `avatarAsset` reads bounded normalized bytes through the optional host
  `ProjectAvatarAssetReader`; it returns `undefined` when no reader is given.

Registration and catalog edits:

- `create` registers a folder and name; `ensure` registers a folder exactly
  once, converges in the same transaction, restores an archived row, and
  returns `{ project, created, changed }`.
- `rename`, `archive`, `restore`, `reorder`, `setAvatar`, `clearAvatar` and
  `updateSettings` all accept an optional `expectedVersion`.

Lifecycle, all driven by a host reporting what it observed or did:

- `applyProbe` records presence, worktree support and optionally Git facts.
- `applyGitFacts` records branch, head, upstream and divergence.
- `setDefaultBranch` records the trunk, once.
- `adoptRemoteName` replaces the name only while `nameSource` is `"folder"`.
- `markCloneReady` marks the folder as present once the clone landed.
- `markInitializationReady`, `markInitializationFailed` and
  `retryInitialization` move a project through setup.
- `refresh` puts a project back in line for setup; it is a no-op for `home`.

Every one of these writes only when something actually changed. When the
observation matches what is already stored, or a guard says the change does
not apply, the operation returns the existing row untouched: no version bump,
no event. Archival is the terminal decision: a clone result, a probe, a setup
outcome or a refresh that was already in flight when a project was archived
describes a project nobody has any more, and changes nothing about it.
`restore` is how a project comes back.

Every guarded write asserts that it moved exactly the one row it was decided
against, at exactly the version it was read at, and rereads to confirm the
version advanced by one. A reorder is one transaction over the whole list, so
a catalog that moved underneath it is refused whole rather than left half in
the new order and half in the old.

`formatProjectForModel`, `formatPageForModel` and `formatSettingsForModel` are
public so a host can render the same bounded text the tools use.

## Host boundary

The module owns the `projects` and `project_settings` tables through its
ordered Agent Base migrations. Migration `004-project-folder-record` drops and
recreates both tables rather than migrating column by column: an opaque
repository reference cannot be turned into a canonical folder path, and
inventing one would put unusable rows in front of a person. `repositoryRef`,
`kind`, `storageKey`, `presence` and `initializationStatus` are `NOT NULL`.
Database operations use `ctx.db`, and multi-step mutations compose with
`ctx.inTx(...)`.

Agent Base owns durable tool-call completion. The module does not maintain a
second receipt, fingerprint, proof, or replay system. Concurrent ensure calls
converge through the catalog transaction and the folder uniqueness constraint.

Every changed mutation is represented by one frozen event: `project_created`,
`project_renamed`, `project_archived`, `project_restored`,
`project_reordered`, `project_avatar_updated`, `project_avatar_cleared`,
`project_settings_updated`, or `project_state_changed` carrying the reason the
lifecycle moved. Transactional and post-commit listeners receive the same
event object. Post-commit listener failures are contained and optionally
reported through `onPostCommitError`. Registration uses stdlib
`afterCommit(ctx, ...)`.

Authorization defaults to same-owner access only; a host policy may grant
cross-agent reads or actions. The avatar byte reader is an optional host
boundary: it receives `(ctx, agentId, hash)` and must return a bounded
`{ bytes, hash, mediaType }` asset or `undefined`. The module resolves the
owning catalog row and applies the normal same-owner authorization before
invoking it. Missing readers degrade to metadata-only avatar support.
