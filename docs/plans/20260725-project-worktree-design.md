# Projects and Managed Workspaces

Status: proposed

## End Result

Rig will have a durable `Project` entity for every directory in which a session runs. Creating a
session will synchronously resolve or create its project, persist the relationship, and publish the
new state before returning. The desktop can therefore render a placeholder project immediately
while bounded background initialization improves its name and avatar.

The same design introduces `ProjectWorkspace`, the entity behind the product's future "Create
worktree" action. A managed workspace is a directory owned by Rig under
`$RIG_HOME/workspaces/<project-storage-key>/<workspace-storage-key>`. Sessions opened at that exact
path belong to the original project and optionally to that workspace. An arbitrary directory,
including an externally-created Git worktree, remains a distinct project.

The observable result is:

- Every primary session and subagent has a non-null `projectId`.
- A session may additionally have a `workspaceId`.
- Projects appear immediately with `initializing` status and reach `ready` or `failed` without
  blocking the session.
- Project names and avatars can be changed through the daemon API.
- Project, workspace, and session changes use the same global event contract in both in-memory and
  durable queue modes.
- Desktop synchronization starts from one consistent snapshot and continues from an opaque event
  cursor without gaps.
- The user's home directory is represented by one `home` project with a built-in Home visual.
- Managed workspaces are created asynchronously and archived idempotently. Archiving immediately
  prevents new work, archives attached sessions, then removes only the verified Rig-owned worktree.

## Product Decisions

### Project identity is a fixed directory

`Project.path` is the canonical real path of the directory at creation time and is immutable.
Project identity is not inferred from a Git remote, inode, repository root, or current directory
name.

Consequences:

- Opening `/code/app` twice resolves the same project.
- Opening a symlink to `/code/app` resolves the same project because the existing directory is
  canonicalized with `realpath`.
- Opening `/code/app/packages/api` creates a different project, even if it is inside the same Git
  repository.
- Moving `/code/app` does not move its project. The old project remains associated with the old
  path, and a session in the new path creates a new project.
- Two ordinary clones with the same remote are two projects.
- Only an exact path already recorded as a Rig-managed workspace maps back to another project's
  `projectId`.

This deliberately differs from gstack's remote-based aggregation. Gstack's remote parsing is useful
for stable human naming, but remote identity would violate the fixed-folder rule and would
accidentally merge clones.

### "Work3" is modeled as ProjectWorkspace

The spoken product term "Work3" is treated as the worktree/workspace concept. The protocol and
database entity is `ProjectWorkspace`, while the initial implementation has
`kind: "git_worktree"`. This leaves room for a future copied workspace or remote workspace without
renaming the entity. User-facing copy should say "Worktree" while only Git worktrees are supported.

### Display identity and disk identity are separate

Projects and workspaces each have:

- A CUID2 `id` used by APIs and relationships.
- An immutable, human-readable `storageKey` used in Rig-owned paths.
- A mutable, unique `name` shown to people.

Changing the visible name never moves a directory. This keeps user customization independent from
filesystem lifecycle and makes stale desktop references harmless.

### Initialization is enrichment, not correctness

The minimal project row, fallback name, and session relationship are correctness-critical and are
committed together. Git inspection, image scanning, image decoding, and network avatar lookup are
optional enrichment with explicit time, byte, candidate, and concurrency limits. Their failure
cannot fail an otherwise valid session.

## Existing Rig Context

The implementation must extend these existing contracts rather than creating a second persistence
or synchronization path:

- `packages/rig/sources/server/initializeSessionDatabase.ts` owns the SQLite schema.
- `PersistentSessionStore` persists session state and commits durable global events with session
  mutations.
- `InMemorySessionStore` mirrors session behavior for tests and embedded use.
- `GlobalEventQueue` currently only exists when the durable queue setting is enabled.
- `PersistentGlobalEventQueue` currently stores only `SessionEvent` and requires a `session_id`.
- `createProtocolHttpServer.ts` exposes session lists, session event streams, and the optional global
  stream.
- `normalizeProjectCwd` already canonicalizes existing paths for project-scoped secrets.
- `project_secret_attachments` is currently keyed by canonical cwd and should become a real
  `project_id` relationship.
- Happy sync is session-oriented. Project and workspace sync for Rig-native desktops belongs in the
  Rig protocol first; Happy session metadata should be extended with IDs without inventing a second
  project database.
- `sharp` and CUID2 are already dependencies.

## Domain Model

```text
Project
  1 ──────────────── * ProjectWorkspace
  │                         │
  │                         │ 0..1
  │                         ▼
  └─────────────────── * Session
                              │
                              └── subagents inherit both IDs

ProjectAvatarAsset
  1 ──────────────── * Project (nullable reference; built-ins have no asset)
```

### Project

```ts
type ProjectKind = "regular" | "home";
type ProjectInitializationStatus = "initializing" | "ready" | "failed";
type ProjectNameSource = "folder" | "git_remote" | "user";
type ProjectAvatarSource = "repository" | "hosting" | "user";

interface ProjectAvatar {
    hash: string; // lowercase SHA-256 of normalized bytes
    height: number;
    mediaType: "image/webp";
    source: ProjectAvatarSource;
    url: string; // immutable daemon URL containing the hash
    width: number;
}

interface Project {
    id: string; // CUID2
    path: string; // immutable canonical absolute path
    storageKey: string; // immutable globally unique disk-safe slug
    kind: ProjectKind;
    name: string; // mutable, globally unique case-insensitively
    nameSource: ProjectNameSource;
    avatar?: ProjectAvatar;
    avatarBuiltin?: "home";
    initializationStatus: ProjectInitializationStatus;
    initializationError?: string; // human-readable, bounded
    initializationAttempt: number;
    version: number; // monotonic, incremented by every committed project mutation
    createdAt: number;
    updatedAt: number;
}
```

SQLite table:

```sql
CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL UNIQUE,
    name_source TEXT NOT NULL,
    avatar_hash TEXT REFERENCES project_avatar_assets(hash),
    avatar_source TEXT,
    initialization_status TEXT NOT NULL,
    initialization_error TEXT,
    initialization_attempt INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
);
```

`avatarBuiltin` is derived from `kind === "home" && avatar_hash IS NULL`; it does not need another
column. `name_key` is internal: normalize the visible name to NFKC and apply locale-independent full
Unicode case folding in application code. SQLite `NOCASE` is ASCII-only and is not sufficient for
the user-visible uniqueness contract.

### Project avatar asset

```sql
CREATE TABLE project_avatar_assets (
    hash TEXT PRIMARY KEY,
    media_type TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    dereferenced_at_ms INTEGER
);
```

The file location is derived, never accepted from a client:

```text
$RIG_HOME/assets/project-avatars/<first-two-hash-chars>/<sha256>.webp
```

The project rows are the reference count. When the last reference is removed,
`dereferenced_at_ms` is set; adding any reference clears it. A keyed asset-store mutex serializes
write/reference changes and collection for one hash. The collector may claim an asset only in a
transaction that rechecks zero references and a dereference age of at least 24 hours, deletes the
asset row, commits, and then unlinks the file. A later writer always rewrites the content-addressed
file before recreating the row/reference. The delay protects readers that fetched an old project
representation immediately before a change.

### ProjectWorkspace

```ts
type ProjectWorkspaceKind = "git_worktree";
type ProjectWorkspaceStatus =
    | "initializing"
    | "ready"
    | "failed"
    | "archiving"
    | "archive_failed"
    | "archived";

interface ProjectWorkspace {
    id: string; // CUID2
    projectId: string;
    path: string; // immutable reserved path
    storageKey: string; // immutable and unique within its project
    name: string; // mutable and unique within its project
    kind: ProjectWorkspaceKind;
    status: ProjectWorkspaceStatus;
    baseRef?: string;
    branch?: string;
    gitCommonDir: string; // immutable canonical source ownership fact captured at reservation
    error?: string;
    version: number; // monotonic, incremented by every committed workspace mutation
    createdAt: number;
    updatedAt: number;
    archivedAt?: number;
}
```

```sql
CREATE TABLE project_workspaces (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    path TEXT NOT NULL UNIQUE,
    storage_key TEXT NOT NULL COLLATE NOCASE,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    base_ref TEXT,
    branch TEXT,
    git_common_dir TEXT NOT NULL,
    error TEXT,
    client_request_id TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    archived_at_ms INTEGER,
    UNIQUE (project_id, storage_key),
    UNIQUE (project_id, name_key),
    UNIQUE (project_id, client_request_id)
);
```

Workspace names use the same Unicode `name_key` rule as projects. `client_request_id` gives desktop
retries idempotent create semantics. A repeated key returns the existing row only when the
normalized `name` and `baseRef` match; parameter drift returns `409`. Archived workspace names and
paths remain reserved so an old session can never be confused with a later workspace.

### Session changes

Add these persisted and protocol fields:

```ts
interface ProtocolSession {
    projectId: string;
    workspaceId?: string;
    // existing fields
}

interface SessionSummary {
    projectId: string;
    workspaceId?: string;
    // existing fields
}
```

The final rebuilt `sessions` table includes a non-null project reference and an optional workspace
reference. Do not use `ALTER TABLE ... ADD COLUMN ... NOT NULL` against populated SQLite data; the
schema-introduction sequence below backfills a nullable staging column and rebuilds the table.

```sql
CREATE INDEX sessions_project_activity
    ON sessions(project_id, last_message_at_ms DESC, updated_at_ms DESC);
CREATE INDEX sessions_workspace_activity
    ON sessions(workspace_id, last_message_at_ms DESC, updated_at_ms DESC);
```

Subagents and forks inherit IDs from their parent/source. They must not re-resolve the path because
that creates a race with workspace archival and wastes filesystem work. Their insert transaction
must still verify that the parent session is not archived and that the inherited workspace is
`ready`; inheritance is not permission to attach new work after archival has started.

Project-scoped secrets become:

```sql
CREATE TABLE project_secret_attachments (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    secret_id TEXT NOT NULL REFERENCES secret_registrations(id) ON DELETE CASCADE,
    PRIMARY KEY (project_id, secret_id)
);
```

## Path Resolution

Session creation resolves ownership synchronously:

```text
canonical cwd
    │
    ├── equals an active project_workspaces.path
    │      └── use workspace.project_id + workspace.id
    │
    ├── equals canonical home directory
    │      └── ensure Project(kind=home)
    │
    └── otherwise
           └── ensure Project(kind=regular, path=cwd)
```

Rules:

1. The requested cwd must exist and be a directory. Directory-creating APIs create it before
   session creation.
2. Resolve to an absolute path, then use native `realpath`.
3. Match workspaces by exact canonical path. Do not match arbitrary descendants of the managed
   workspace root and do not infer ownership from directory naming.
4. Only a workspace in `ready` accepts new sessions. The status check and session insert occur in
   the same `BEGIN IMMEDIATE` transaction.
5. A client-provided `workspaceId`, when added to session creation, is only a consistency assertion.
   The daemon still resolves the path and rejects a mismatched ID.
6. Project paths are compared using the platform's actual canonical path. SQLite uniqueness protects
   concurrent creators.

The session and a newly-created project are committed in one `BEGIN IMMEDIATE` transaction:

```text
BEGIN IMMEDIATE
  if cwd is Home, ensure the ready Home project and never schedule initialization
  otherwise ensure a regular project row with initializing state
  reserve unique project name and storage key
  if attaching to a workspace, re-read and require status = ready
  insert session(project_id, workspace_id, ...)
  append project_created (only when inserted)
  append session_created
COMMIT
append/publish committed events in the same order under GlobalStateCoordinator
schedule project initialization only for a newly inserted or retryable regular project
```

No observer sees a session whose project does not exist. A crash after commit but before in-memory
publication changes the in-memory stream ID on restart, forcing the next state snapshot; durable
mode already has both events in the same transaction. The coordinator contract below prevents a
live process from capturing a snapshot/cursor between commit and in-memory append.

## Project Naming

### Immediate fallback

At row creation:

- Regular project base name: the final path segment.
- Home project base name: `Home`.
- Empty or root-like segment: `Project`.

The visible name and its Unicode `name_key` are reserved in the same transaction. The first
collision uses `Name (2)`, then `Name (3)`, and so on. Existing names are never renumbered when an
earlier project is renamed.

### Git enrichment

Git affects the name only when `git rev-parse --show-toplevel` equals `Project.path`. A directory
merely nested inside a repository retains its folder name.

Remote selection:

1. The remote tracked by `HEAD@{upstream}`, when present.
2. `origin`.
3. The first configured non-local remote in Git's stable output order.

Parse HTTPS, `ssh://`, and SCP-style remotes without invoking a shell. Use the final remote path
segment, remove one `.git` suffix, and percent-decode only valid UTF-8. A malformed or local-path
remote is ignored.

This adopts gstack's useful behavior—remote-derived names with a folder fallback—without adopting
its remote-as-project-identity behavior.

At initialization finalization:

- If `nameSource` is still `folder`, reserve the detected Git name and set
  `nameSource: "git_remote"`.
- If a user renamed the project while initialization ran, keep the user's name.
- Resolve collisions again at commit time.

### Storage key

The immutable `storageKey` is created from the original folder segment, not the later Git name:

1. Transliterate with the existing `deunicode` dependency.
2. Lowercase.
3. Replace non-alphanumeric runs with `-`.
4. Trim separators and cap the readable portion at 48 characters.
5. Fall back to `project`.
6. Reserve globally with `-2`, `-3`, and so on.

`home` is reserved for the Home project. Storage keys are portable and never contain path
separators, dots, whitespace, shell metacharacters, or user-supplied absolute paths.

## Avatar Discovery

Avatar discovery is deterministic, bounded, and ordered. The first successfully decoded candidate
at the highest score wins.

### Source priority

1. User-uploaded avatar.
2. Repository image candidate.
3. Repository-hosting project avatar.
4. Repository-hosting owner or organization avatar.
5. No file avatar; the desktop renders initials. Home uses the built-in Home visual.

SourceTree provides the baseline precedent: use the hosting service's avatar when available, then
look for repository files named `icon` or `logo`. Rig extends that policy with deterministic scoring
and resource limits.

### Repository candidates

Only scan when the project path is the Git top level. Never follow symlinks. Ignore `.git`,
`node_modules`, vendor, build, cache, coverage, and generated output directories.

Candidate locations, in priority order:

- Repository root.
- `.github`, `assets`, `branding`, `docs`, `public`, `resources`, `static`.
- One `src` child such as `src/assets`.

Accepted raster formats are PNG, JPEG, WebP, GIF first frame, and TIFF. SVG and ICNS are excluded
initially: SVG expands the untrusted parser and external-resource surface, while ICNS adds little
cross-platform value. A later change can add them with dedicated fixtures.

Score signals:

- Exact stem `logo` before `icon`, then `app-icon`, `appicon`, `brand`.
- Root before common asset directories.
- Approximately square aspect ratio.
- Dimensions from 64 through 2048 pixels.
- Penalties for `wordmark`, `banner`, `screenshot`, `badge`, `favicon`, `dark`, and `light`.

Limits:

- At most 200 directory entries inspected.
- At most 32 image candidates decoded.
- At most 8 MiB compressed bytes per file.
- At most 25 million decoded input pixels.
- At most 2 seconds of local discovery work.

### Hosting candidates

Network lookup is best-effort, unauthenticated, HTTPS-only, and limited to a built-in allowlist:

- GitHub.com: owner or organization `avatar_url`; GitHub has no repository avatar.
- GitLab.com: project `avatar_url`, then namespace owner avatar.
- Bitbucket Cloud: repository or workspace avatar link returned by its API.

Do not read or forward Git credentials, cookies, environment tokens, or provider credentials. Do
not call arbitrary Git remote hosts, redirects outside the allowlist, private IP addresses, or
GitHub Enterprise hosts in v1. Each request has a 2-second deadline, a 3-redirect cap that retains
the allowlist, an image content-type requirement, and an 8 MiB streaming limit.

Remote owner, namespace, workspace, and repository segments are untrusted repository data. Each
hosting adapter validates decoded segments against that provider's strict character and length
rules, rejects `.`, `..`, separators, query/fragment characters, and ambiguous percent encoding,
then constructs API URLs from validated URL path components. It never string-substitutes a remote
path into an API URL.

Private repositories commonly produce no hosting avatar without authentication; that is a normal
`ready` result, not an initialization failure.

### Normalization and storage

Every accepted source goes through the same `sharp` pipeline:

1. Decode with input pixel and byte limits.
2. Apply orientation.
3. Take the first frame.
4. Resize inside a 256 by 256 transparent canvas without enlargement.
5. Encode WebP at quality 82, preserving alpha.
6. Compute lowercase SHA-256 over the final encoded bytes.
7. Write a temporary file inside the avatar asset directory with mode `0600`.
8. Under the keyed hash mutex, atomically rename over the content-addressed path even when it
   already exists. Identical bytes make the overwrite idempotent and close the collector race.
9. In the same keyed critical section, commit the asset row, clear `dereferenced_at_ms`, and update
   the project reference.
10. Publish `project_updated` only after commit.

The API serves:

```http
GET /project-assets/<sha256>
ETag: "<sha256>"
Cache-Control: public, max-age=31536000, immutable
Content-Type: image/webp
```

The route accepts exactly 64 lowercase hexadecimal characters and derives the file path itself.

## Initialization State Machine

```text
                 retry on daemon startup or explicit refresh
                ┌──────────────────────────────────────────┐
                ▼                                          │
          initializing ───────── success ───────────────► ready
                │
                └──────── unexpected bounded failure ───► failed
```

The project already has a usable name in every state. "No better name/avatar found" is success.

`ProjectInitializationService`:

- Uses a keyed queue so only one job per project can run.
- Runs at most two projects concurrently.
- Uses `TrackedTaskDrain` so daemon shutdown waits only for bounded filesystem commits, not network
  deadlines.
- On startup, schedules `initializing` projects and `failed` projects with fewer than three
  attempts.
- Captures `initializationAttempt` and a bounded human-readable error.
- Uses compare-and-set updates so manual name/avatar changes made during discovery win.
- Commits name, avatar, status, and the global event atomically.
- Never leaves an unbounded promise, watcher, recursive scan, or image buffer.

`POST /projects/:projectId/refresh` resets a failed regular project to `initializing`, clears its
bounded error, and schedules a new attempt. It is also available for an explicit best-effort
metadata refresh after a remote or repository logo changes. It does not overwrite a user-selected
name or avatar.

## Home Project

The canonical host home directory resolves to exactly one project:

```ts
{
    kind: "home",
    name: "Home",
    storageKey: "home",
    initializationStatus: "ready",
    avatarBuiltin: "home"
}
```

It skips Git and repository image discovery even if the home directory happens to contain `.git`.
The desktop can group or visually de-emphasize Home sessions based on `kind`, without guessing from
the path or name.

Users may rename Home or upload a custom avatar. Deleting the custom avatar restores the built-in
Home visual. `kind` and `path` remain immutable.

## Managed Workspace Lifecycle

### Root and layout

The default root is:

```text
$RIG_HOME/workspaces/<project.storageKey>/<workspace.storageKey>
```

`RIG_HOME` already provides a single configurable Rig state root. No second `~/happy` or unrelated
workspace setting is introduced in v1. A future explicit `workspaces_root` setting can override the
derived location without moving existing workspace rows.

Workspace names use the same case-insensitive suffix behavior within one project. Workspace
storage keys use the project slug algorithm and are immutable.

### Creation

```http
POST /projects/:projectId/workspaces
{
  "clientRequestId": "desktop-generated-id",
  "name": "auth-refactor",
  "baseRef": "main"
}
```

Before acquiring a SQLite write lock, bounded Git preflight verifies that the project exists, is a
Git top level, captures its canonical common Git directory, and resolves `baseRef` to one commit
OID. `baseRef` is bounded, contains no control characters, must not start with `-`, and is passed to
`git rev-parse --verify --end-of-options <baseRef>^{commit}` as one argument. The transaction then
rechecks the project row, reserves the workspace ID/name/storage key/path plus common Git directory
in `initializing`, appends `workspace_created`, commits, and returns `202`. No subprocess runs while
`BEGIN IMMEDIATE` holds the database write lock.

A repeated `clientRequestId` returns the existing workspace only when normalized `name` and
`baseRef` match the stored request; otherwise it returns `409`.

The worker receives the resolved hexadecimal commit OID and performs a bounded argument-array
invocation equivalent to:

```text
git -C <project.path> worktree add --detach -- <workspace.path> <commit-oid>
```

The fixed `--detach` plus the verified OID remove both Git option injection and implicit branch
creation. Branch creation details are intentionally left to a later product decision. The first
API requires an existing commit-ish `baseRef`; it does not guess remote branches or mutate a branch
name.

On success it verifies that:

- The resulting canonical path equals the reserved path.
- `git rev-parse --show-toplevel` equals the workspace path.
- The worktree's common Git directory matches the source project's common Git directory.

It then marks the workspace `ready` and publishes `workspace_updated`. On failure it records
`failed`, retains the reserved identity, removes only a verified partial worktree, runs bounded
`git worktree prune` when the source common Git directory still exists, and publishes the error. A
failed row can be retried explicitly in a later API change.

Finalization is a compare-and-set on `status = "initializing"`. Archiving may change the status
while `git worktree add` is running; in that case the creator must not mark the row `ready`. It
hands any verified partial result to archival cleanup and exits. The same lifecycle lock prevents
creation finalization and archive deletion from acting on the path concurrently.

Sessions cannot start in an `initializing` workspace. The desktop watches for `ready`, then creates
the chat. This keeps session cwd and sandbox construction honest rather than queuing a session
against a directory that does not yet exist.

### Archival

```http
POST /projects/:projectId/workspaces/:workspaceId/archive
{ "clientRequestId": "desktop-generated-id" }
```

Archival is idempotent:

```text
initializing / ready / failed
      │
      ▼
  archiving ───── delete succeeds ─────► archived
      │
      └────────── delete fails ─────────► archive_failed
                                               │
                                               └── retry ─► archiving
```

The first phase runs under the per-workspace lifecycle lock and
`GlobalStateCoordinator`. It prevents new session inserts and event appends while the transaction:

1. Changes the workspace to `archiving`, which blocks new sessions and submissions.
2. Marks every attached primary session and subagent archived with
   `reason: "workspace_archived"`.
3. Appends one `workspace_updated` plus one `session_archived` event per session.
4. Commits, immediately flips every cached `InMemorySession` to the same terminal fence, appends to
   the selected global queue, and publishes all events before releasing the coordinator.

Every session submission, subagent/fork insert, and session-event append checks that fence in the
same coordinator boundary. A completion arriving from an already-running provider after commit is
discarded as late terminal output and cannot append after `session_archived`. Subagent/fork
insertion also checks the parent and workspace status inside its own `BEGIN IMMEDIATE`
transaction. Session-specific subscribers receive their archive event; the global stream receives
the whole committed sequence.

After commit, the worker:

1. Cancels an in-flight workspace creator, then aborts active turns and descendants.
2. Stops background processes.
3. Closes remote terminal attachments.
4. If the persisted common Git directory exists, unlocks only the exact verified worktree when
   needed, runs `git worktree remove --force --force`, and then `git worktree prune`. The second
   `--force` covers worktrees with submodules.
5. Removes a leftover path only after revalidating the persisted path, the managed root boundary,
   the project and workspace storage-key components, and non-symlink status. The common Git
   directory must match the persisted `gitCommonDir`, unless both the source repository and its
   common Git directory are missing; that explicit missing-source case may rely on the remaining
   immutable ownership facts.
6. Marks `archived` and publishes `workspace_updated`.

If process shutdown or deletion fails, the workspace becomes `archive_failed`; sessions remain
archived and the path stays blocked. Locked-worktree and submodule removal failures are expected
`archive_failed` cases with readable diagnostics, not reasons to weaken boundary checks. A retry
never reactivates sessions. Rig never recursively deletes a client-supplied path, a project path,
the workspace root, a symlink target, or a path that does not match all stored ownership facts.

## Global Synchronization

### One queue contract, two implementations

`GlobalEventQueue` becomes always available:

- `InMemoryGlobalEventQueue`: default, bounded ring buffer, lost on daemon restart.
- `PersistentGlobalEventQueue`: SQLite-backed, survives restart and supports explicit trim.

The `durableGlobalEventQueue` setting selects retention, not endpoint availability. Switching
implementations closes subscribers and changes the stream ID so clients perform a new snapshot.

### Event union

```ts
type GlobalEvent = SessionEvent | ProjectEvent | ProjectWorkspaceEvent;

type ProjectEvent =
    | BaseProjectEvent<"project_created", { project: Project }>
    | BaseProjectEvent<"project_updated", { project: Project }>;

type ProjectWorkspaceEvent =
    | BaseWorkspaceEvent<"workspace_created", { workspace: ProjectWorkspace }>
    | BaseWorkspaceEvent<"workspace_updated", { workspace: ProjectWorkspace }>;
```

Session events keep their existing shape. Project events carry top-level `projectId`; workspace
events carry `projectId` and `workspaceId`. Every project/workspace payload includes its monotonic
`version`. A client applies a full-entity event only when its version is greater than the locally
stored version; duplicate or reordered older events are ignored.

The durable table stores neutral aggregate columns:

```sql
CREATE TABLE durable_global_events (
    position INTEGER PRIMARY KEY AUTOINCREMENT,
    stream_id TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    aggregate_kind TEXT NOT NULL, -- session | project | workspace
    aggregate_id TEXT NOT NULL,
    type TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    data_json TEXT NOT NULL
);

CREATE TABLE durable_global_event_streams (
    stream_id TEXT PRIMARY KEY,
    last_position INTEGER NOT NULL,
    trimmed_through INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);
```

The public cursor is opaque and includes both stream identity and position. Clients must never parse
or increment it.

### Consistent bootstrap

Add one endpoint:

```http
GET /state

{
  "cursor": "<opaque>",
  "projects": [...],
  "workspaces": [...],
  "sessions": [...], // summaries only, bounded recent window
  "hasMoreSessions": true,
  "sessionsNextCursor": "<opaque-session-list-cursor>"
}
```

`sessions` contains at most 500 `SessionSummary` rows in the same ordering as `GET /sessions`; it
never embeds messages or events. The desktop paginates the existing `GET /sessions` endpoint for
older history. Projects and workspaces are the complete current entity sets; before those sets
approach the separately configured HTTP response byte ceiling, this endpoint must gain pagination
rather than silently truncate them.

The snapshot and cursor are captured under `GlobalStateCoordinator`, the same consistency boundary
used for mutations. The desktop then opens:

```http
GET /events/global?after=<opaque>
Accept: text/event-stream
```

If an in-memory queue restarted, a ring buffer trimmed the cursor, or queue mode changed, the stream
returns `409` and the client repeats `GET /state`. This is required even in durable mode because
clients may retain a cursor longer than the server retains events.

The in-memory queue stores at most 10,000 events. Its generated stream ID prevents a low numeric
cursor from an old daemon instance from being mistaken for a valid cursor in a new instance.

### Transaction and publication rule

`GlobalStateCoordinator` serializes only the short synchronous part of every mutation visible on
the global stream:

1. Acquire the coordinator and any narrower aggregate/lifecycle lock.
2. Run the SQLite transaction. In durable mode, append global event rows in that transaction.
3. Commit.
4. In in-memory mode, synchronously append the committed events to the infallible bounded ring.
5. Update cached terminal/version state, publish notifications, then release the coordinator.

It never awaits network, image, Git, process shutdown, or other subprocess work. Those operations
run before reservation or after publication as their state machine specifies.

`GET /state` acquires the same coordinator, reads rows in one SQLite read transaction, and captures
the selected queue cursor before releasing it. Therefore no live mutation can commit between the
row snapshot and cursor capture. In durable mode the event row and entity mutation are atomic; in
in-memory mode commit-to-ring-append cannot be observed halfway. A process crash in that tiny
interval changes the stream ID and forces `409` plus a new snapshot.

No external or in-memory observer runs before commit. Optional Happy metadata observation also runs
after commit.

## HTTP API

### Read

```text
GET /state
GET /projects
GET /projects/:projectId
GET /projects/:projectId/workspaces
GET /project-assets/:hash
```

`GET /sessions` continues to exist, remains paginated, and adds `projectId` and optional
`workspaceId`.

### Project mutation

```http
PATCH /projects/:projectId
{ "name": "Visible name" }
```

- Trim surrounding whitespace.
- Reject control characters, empty names, and names longer than 100 Unicode scalar values.
- Resolve a collision with ` (2)`, ` (3)`, etc., and return the actual reserved name.
- Set `nameSource: "user"`.
- Reject attempts to mutate path, ID, storage key, or kind.
- Increment and return the monotonic project `version`.

```http
PUT /projects/:projectId/avatar
Content-Type: image/png | image/jpeg | image/webp | image/gif | image/tiff
If-Match: "<project-version>"
<raw bytes, max 8 MiB>
```

The daemon normalizes the image, stores it by hash, sets source `user`, and returns the updated
project. Conditional update prevents a stale desktop from overwriting a newer choice.

```http
DELETE /projects/:projectId/avatar
```

For regular projects this clears the manual override and schedules bounded automatic discovery. For
Home it restores the built-in visual.

```http
POST /projects/:projectId/refresh
```

For a regular project this schedules the bounded initializer and returns the project in
`initializing`. Home returns `409` because it has no discovery lifecycle. User-selected name and
avatar sources remain protected.

All successful mutations publish `project_updated`.

### Workspace mutation

```text
POST /projects/:projectId/workspaces
PATCH /projects/:projectId/workspaces/:workspaceId
POST /projects/:projectId/workspaces/:workspaceId/archive
```

The patch endpoint changes only the visible name. Path, storage key, kind, project ID, and archived
identity are immutable. Workspace mutations accept `If-Match: "<workspace-version>"`, increment the
version, and return the actual reserved name.

### Errors

All user-facing errors are human-readable English. Important statuses:

- `400`: invalid name, image, cursor, ref, or body.
- `404`: unknown project/workspace/asset.
- `409`: stale event cursor, stale conditional mutation, path collision, wrong project/workspace
  relationship, idempotency-key parameter drift, or workspace lifecycle conflict.
- `413`: avatar body too large.
- `415`: unsupported avatar media type.
- `202`: asynchronous workspace creation/archive accepted.

## Happy and Desktop Integration

Rig-native desktop clients use `/state` and the global event stream.

Happy currently synchronizes sessions individually. Extend Happy session metadata with:

```ts
project: { id: string; kind: ProjectKind; name: string };
workspace?: { id: string; kind: ProjectWorkspaceKind; name: string };
```

This lets existing remote session UIs group chats without making Happy a second owner of project
state. Project mutation and workspace creation remain Rig protocol capabilities until Happy has an
explicit machine-level project protocol. The design does not send local avatar bytes through every
session metadata update.

## Schema Introduction

The schema change is one atomic current-schema upgrade, not a permanent compatibility layer:

1. Create project/avatar/workspace tables, including Unicode `name_key`, monotonic entity versions,
   avatar dereference timestamps, and persisted workspace Git ownership facts.
2. Add nullable `project_id` and `workspace_id` session columns in a rebuilt `sessions` table.
3. In the same migration transaction, create one project per canonical historical cwd, with the Home
   special case, then assign all historical sessions. Subagents inherit their root session's IDs.
4. Convert cwd-keyed project secret attachments to project IDs.
5. Validate there are no null project IDs or dangling references.
6. Rebuild the sessions table with `project_id NOT NULL`.
7. Replace the durable global event table with the neutral aggregate schema while retaining current
   untrimmed session events and their ordering. Create a fresh stream ID and its
   `last_position`/`trimmed_through` row so every pre-upgrade cursor deterministically receives
   `409`; never let an old position alias a new stream.
8. Increment the schema version and commit.

Canonicalization requires filesystem access and therefore cannot be expressed wholly in SQL. Read
only distinct historical cwd values, normalize each once before the transaction, then execute all
database changes atomically. Do not deserialize historical event payloads during migration.

If two historical spellings resolve to one existing directory, they intentionally converge on one
project. A missing historical directory uses its normalized absolute path and a folder fallback;
the immutable project remains useful for history.

Because Rig is early-stage, remove the cwd-keyed runtime behavior after the upgrade. Do not retain
dual reads, deprecated protocol fields, aliases, or startup repair loops.

## Failure and Recovery

### Daemon restart

- `initializing` projects are rescheduled.
- `initializing` workspaces are reconciled from DB plus Git worktree facts. A fully-created verified
  worktree becomes `ready` only through a `status = "initializing"` compare-and-set; a verified
  partial becomes `failed` and its stale Git administrative entry is removed/pruned; an unrelated
  path is never deleted.
- `archiving` workspaces resume abort/removal.
- In-memory queue clients receive `409` for their old stream ID and reload `/state`.
- Durable queue clients replay committed events.

### Concurrent creation

SQLite uniqueness and `BEGIN IMMEDIATE` choose one project row for a path. A loser re-reads the
winner and attaches its session. Name and storage-key suffix allocation happens under the same write
transaction.

### Manual update during initialization

The initializer records the observed project version and name/avatar sources. Its final transaction
updates discovered fields only when their source is still non-user and their relevant generation
has not changed; it always transitions initialization status through compare-and-set and increments
the project version. Manual choices therefore win without canceling the remaining job.

### Missing project directory

An existing project whose directory later disappears stays in history. New sessions for it fail
with a readable missing-directory error. There is no automatic path relocation. A managed
workspace may still be archived: when both the source directory and persisted common Git directory
are absent, deletion relies on exact derived-root, storage-key, non-symlink, and persisted-path
ownership checks and cannot dead-end solely because the source clone was removed.

### Avatar file loss

If the DB references a missing or corrupt asset, the asset endpoint returns 404, records a bounded
diagnostic, clears the broken automatic reference in a transaction, and schedules rediscovery. It
does not scan or repair unrelated rows at daemon startup. A missing user-selected asset remains
visible as an error until the user replaces or clears it.

## Security and Resource Boundaries

- Project paths come from session cwd but are canonicalized and immutable.
- Workspace deletion is restricted to exact persisted paths under the derived managed root.
- Git commands use direct executable arguments, bounded output, timeout, and abort signal; never a
  shell-built command. Client refs are syntax-bounded, cannot begin with `-`, resolve through
  `--end-of-options`, and worktree creation receives only the resolved commit OID after `--`.
- Avatar scans do not follow symlinks or leave the project directory.
- Image input has compressed-byte and decoded-pixel caps.
- Remote avatar requests use a fixed public-host allowlist and never attach credentials.
- Redirects are revalidated at every hop to prevent SSRF.
- Hosting owner/repository path components are provider-validated before URL construction.
- Asset URLs accept hashes, not filesystem paths.
- Initialization queues have bounded concurrency and attempts.
- In-memory global events have an explicit 10,000-event retention bound.
- Content-addressed avatar files have delayed orphan collection.
- Asset write/reference/collection for one hash is serialized, and orphan age is persisted.
- Archival events commit before external notification, terminal session fences reject late output,
  and failures never restore archived sessions.

## Implementation Plan

Every task includes its tests and must be green before the next task. Behavior crossing terminal,
daemon, protocol, database, processes, filesystem, and event streams receives gym coverage in
addition to focused unit tests.

### Task 1: Introduce project protocol and persistence

- [ ] Add `Project`, avatar, initialization, and project event types under `protocol`.
- [ ] Add project/avatar tables, Unicode name keys, entity versions, dereference timestamps, and
      the project foreign key on a rebuilt sessions table.
- [ ] Implement project repositories for persistent and in-memory stores.
- [ ] Replace cwd-keyed project secrets with project IDs.
- [ ] Add unit tests for canonical-path identity, Home identity, concurrent ensure, unique names,
      unique storage keys, and project-scoped secrets.
- [ ] Add migration tests for historical cwd convergence, missing paths, subagent inheritance,
      rollback on failure, and no null project IDs.
- [ ] Run focused protocol/server tests and typecheck before Task 2.

### Task 2: Make session creation project-atomic

- [ ] Resolve project/workspace ownership before runtime construction and recheck workspace status
      in the session insert transaction.
- [ ] Commit a new project, session, and ordered created events atomically.
- [ ] Add `projectId` and optional `workspaceId` to session state, summaries, forks, and subagents;
      make inherited inserts reject terminal parents/workspaces transactionally.
- [ ] Ensure failed runtime creation cannot leave an orphan session.
- [ ] Add deterministic tests for new/existing projects, same-path races, symlink aliases, nested
      directories, forks, subagents, and transaction rollback.
- [ ] Add a gym test proving two CLI sessions in one directory share one immediately visible project.
- [ ] Run focused server/client/gym tests before Task 3.

### Task 3: Provide one global synchronization contract

- [ ] Generalize global events from `SessionEvent` to the aggregate union.
- [ ] Add `InMemoryGlobalEventQueue` with stream ID, opaque cursors, bounds, replay, and trim.
- [ ] Upgrade `PersistentGlobalEventQueue` to the same cursor and aggregate contract.
- [ ] Add `GlobalStateCoordinator`, per-entity version guards, and atomic bounded `GET /state`.
- [ ] Update protocol clients to snapshot, replay, and recover from `409`.
- [ ] Add tests for commit-before-publish, project-before-session ordering, queue mode switches,
      fresh migration stream IDs, trim-state accounting, reconnect races, bounded session snapshots,
      and duplicate/reordered version application.
- [ ] Update the existing durable-queue gym scenario to cover projects and add an in-memory scenario.
- [ ] Run focused server/client/gym tests before Task 4.

### Task 4: Add bounded project initialization

- [ ] Implement the keyed initialization queue and crash rescheduling.
- [ ] Implement Git-top-level detection, upstream remote selection, URL parsing, and detected names.
- [ ] Implement case-insensitive collision suffixing with manual-update compare-and-set behavior.
- [ ] Add explicit refresh/retry and ensure Home never enters the initialization queue.
- [ ] Add tests for HTTPS/SSH/SCP remotes, malformed/local remotes, nested directories, duplicates,
      timeouts, startup recovery, and a manual rename racing initialization.
- [ ] Add a gym test proving session startup is not blocked by delayed initialization.
- [ ] Run focused server/gym tests before Task 5.

### Task 5: Discover, normalize, and serve avatars

- [ ] Implement bounded repository candidate collection and deterministic scoring.
- [ ] Implement allowlisted unauthenticated hosting adapters for GitHub.com, GitLab.com, and
      Bitbucket Cloud with strict provider path-component validation.
- [ ] Implement the 256-pixel WebP normalizer, atomic content-addressed storage, and delayed orphan
      collection with dereference timestamps and per-hash serialization.
- [ ] Add asset serving, upload, delete/reset, conditional update, and project avatar events.
- [ ] Add image fixtures and tests for scoring, formats, orientation, alpha, oversize bytes, pixel
      bombs, corrupt images, symlink escapes, redirects, SSRF targets, timeouts, dedupe, replacement,
      cache headers, and garbage collection.
- [ ] Add HTTP tests proving a manual avatar cannot be overwritten by a late initializer.
- [ ] Run focused images/server tests before Task 6.

### Task 6: Add project APIs and Happy metadata

- [ ] Add project list/get/rename/refresh endpoints, version preconditions, and client methods.
- [ ] Add Home built-in avatar projection and mutation semantics.
- [ ] Add project/workspace IDs and names to Happy session metadata.
- [ ] Add tests for validation, suffixing, immutable fields, Home behavior, event publication, and
      Happy serialization.
- [ ] Add a gym scenario that starts Rig in the fixture home and observes a `home` project.
- [ ] Run focused protocol/server/Happy/gym tests before Task 7.

### Task 7: Introduce managed workspace records and creation

- [ ] Add workspace protocol, table, versioned events, APIs, and parameter-stable idempotency.
- [ ] Derive and reserve safe human-readable workspace paths under `$RIG_HOME/workspaces`.
- [ ] Resolve refs before the write transaction, reject option-shaped inputs, create a detached
      worktree from the verified OID, and perform post-create ownership verification.
- [ ] Reconcile interrupted `initializing` workspaces on daemon restart.
- [ ] Add tests for duplicate names, retry IDs, invalid refs, non-Git projects, path boundaries,
      option injection, parameter drift, archive-during-create, partial creation, stale Git registry
      entries, unrelated preexisting paths, and restart reconciliation.
- [ ] Add a Docker gym test that creates a real Git worktree, waits for `ready`, and starts a session
      with the original `projectId` plus the new `workspaceId`.
- [ ] Run focused server/process/gym tests before Task 8.

### Task 8: Archive managed workspaces safely

- [ ] Add explicit persisted session archival plus cached-session submission/event fencing.
- [ ] Atomically mark the workspace/sessions and append all archive events.
- [ ] Abort runs, descendants, background processes, and terminal attachments after commit while
      proving late provider output cannot append after the terminal event.
- [ ] Remove/unlock/prune the Git worktree with exact ownership and boundary validation, including
      the missing-source and submodule cases.
- [ ] Implement `archive_failed`, retry, and daemon restart reconciliation.
- [ ] Add tests for idempotency, active sessions, concurrent subagent insertion, late completion,
      archive-during-create, delayed processes, source deletion, locked/submodule worktrees, deletion
      failure, symlinks, path swaps, malicious stored/request paths, and event ordering.
- [ ] Add a Docker gym test proving all chats close, the worktree disappears, and both global and
      session streams observe the terminal state.
- [ ] Run focused server/process/gym tests before Task 9.

### Task 9: Verify the end-to-end contract

- [ ] Run all focused unit and integration tests.
- [ ] Run `pnpm test:gym`.
- [ ] Run `pnpm check`, `pnpm lint`, and `pnpm format:check`.
- [ ] Verify project/session/workspace identity across delayed, duplicated, reordered, rejected, and
      already-applied outcomes.
- [ ] Verify initialization and avatar work stay within documented time, byte, candidate, and
      retention bounds.
- [ ] Verify every user-facing string is human-readable English.
- [ ] Update protocol documentation and README examples.

## Acceptance Scenarios

1. Starting two sessions in one ordinary directory creates one project and two attached sessions.
2. Starting a session in a nested directory creates another project.
3. Starting through a symlink to the same existing directory reuses the project.
4. Two clones of the same GitHub repository remain distinct projects and receive `Repo` and
   `Repo (2)` names.
5. A project appears in `/state` as `initializing` before remote/avatar work finishes.
6. A user rename or avatar upload during initialization is not overwritten.
7. In-memory and durable clients receive identical project/workspace event payloads.
8. A stale in-memory cursor produces `409`; the next snapshot contains complete project/workspace
   state plus the bounded session window, with older sessions available through pagination.
9. A session in the canonical home directory belongs to a `home` project.
10. A Rig-managed Git worktree belongs to its source project; an external worktree is a new project.
11. Archiving a workspace immediately blocks submissions and archives every attached session.
12. Archiving deletes only the verified managed worktree and emits terminal events to all relevant
    streams.
13. A stale full-entity event cannot overwrite a newer snapshot because its version is lower.
14. Archiving while worktree creation or subagent insertion is in flight cannot produce a ready
    workspace or a live session after the terminal archive sequence.
15. A malicious option-shaped ref or hosting remote path is rejected before reaching Git or an API
    URL.
16. Avatar reuse racing orphan collection always ends with both a valid DB reference and the
    normalized file present.

## Deliberate Non-goals

- Inferring that arbitrary clones or external worktrees are one project because their remotes match.
- Moving or merging projects.
- Archiving or deleting ordinary projects.
- Authenticated hosting avatar lookup or credential reuse.
- Enterprise/self-hosted Git avatar adapters.
- Recursive repository-wide image search.
- SVG/ICNS avatar decoding in v1.
- Branch naming automation for worktree creation.
- A second project source of truth in Happy or a desktop client.
- Legacy protocol aliases or dual cwd/project-ID runtime behavior after schema introduction.

## Research Notes

- Gstack derives a stable project slug from the Git remote and falls back to the directory basename,
  then caches it. Its newer code-source IDs add a host/path hash so sibling worktrees remain distinct.
  Rig reuses the naming lesson but keeps folder identity authoritative.
- Gstack's Codex session-format spike explicitly notes that Conductor worktrees need grouping above
  raw cwd. Rig solves this with a persisted workspace relationship instead of a remote heuristic.
- SourceTree first uses a remote service avatar when supported, then searches the repository for
  `icon` or `logo` files in TIFF, PNG, JPEG, GIF, or ICNS formats.
- Git's `rev-parse --show-toplevel` is the authoritative check that a project path itself is the
  working tree root.
- GitHub user/organization APIs expose `avatar_url`; GitLab project APIs expose project and owner
  avatars; Bitbucket returns avatar links in API resources.

References:

- https://github.com/garrytan/gstack/blob/main/bin/gstack-slug
- https://github.com/garrytan/gstack/blob/main/bin/gstack-global-discover.ts
- https://github.com/garrytan/gstack/blob/main/docs/spikes/codex-session-format.md
- https://community.atlassian.com/forums/Sourcetree-questions/Where-do-Sourcetree-repo-avatars-come-from/qaq-p/966257
- https://git-scm.com/docs/git-rev-parse
- https://docs.github.com/en/rest/users/users
- https://docs.gitlab.com/api/projects/
- https://developer.atlassian.com/cloud/bitbucket/rest/

## Fable Five Review

An independent skeptical review was run with `anthropic/fable-5` against this document and the
current Rig storage, protocol, queue, and session-store code.

Verdict: **APPROVE WITH CHANGES**. Fable Five found the core architecture sound: fixed-path project
identity, initialization as optional enrichment, a single queue contract, commit-before-publish,
and ownership-verified deletion fit Rig's existing direction. It required four blockers to be
resolved before implementation:

1. Prevent Git option injection by validating `baseRef`, resolving it with `--end-of-options`, and
   passing only a verified OID to fixed-option worktree creation.
2. Add monotonic project/workspace versions and one coordinator around mutation
   commit-to-publication and snapshot-to-cursor capture, so duplicate/reordered events cannot
   regress desktop state.
3. Fence archived in-memory sessions against late provider output, validate all new session/fork
   attachments transactionally, and make archive-during-create a compare-and-set lifecycle.
4. Make worktree cleanup recoverable: remove/prune Git administrative entries, handle submodules
   and locks, and permit strictly verified deletion when the source repository has disappeared.

The review also identified eleven specification-level corrections, all incorporated above:
serialized avatar write/reference/GC with a persisted dereference timestamp; strict hosting path
components; executable SQLite rebuild semantics; Git preflight outside write transactions;
workspace status checks inside session transactions; a fresh durable stream ID and trim state
during schema introduction; bounded session summaries in `/state`; an explicit Home carve-out; a
project refresh API; `409` on idempotency-key parameter drift; and documented locked/submodule
worktree behavior.
