# Git State Tracking for Projects and Workspaces

Status: proposed (revision 2, after adversarial review — see "Reviews" at the end)

Supersedes one line of [`20260725-project-worktree-design.md`](20260725-project-worktree-design.md):
that document listed "Archiving or deleting ordinary projects" as a non-goal. Projects that no
longer exist on disk must now be removable, so that non-goal is withdrawn.

## End Result

Rig knows, continuously and cheaply, what the Git state of every project and managed workspace is,
and pushes that state to clients fast enough that a desktop can render a live "12 files changed,
+430 −87" summary while an agent is still working.

The observable result is:

- Every project reports whether a managed workspace can be created from it, and why not when it
  cannot.
- Every project reports whether its directory still exists. A project whose directory is gone can be
  removed by the user through the API; Rig never removes it silently.
- Directory presence, Git capability, branch, and HEAD are re-derived once at daemon startup and
  published as ordinary durable entity updates.
- For every _watched_ project and workspace, Rig maintains a live change snapshot: branch, upstream
  divergence, HEAD, total insertions and deletions, and the per-file change list with per-file
  insertion and deletion counts.
- Commits, checkouts, branch switches, and rebases are observed at kernel latency on every platform.
  Working-tree edits are observed at kernel latency on macOS and Windows and through Rig's own write
  signal everywhere; a Linux user hand-editing files in their own terminal is the one case that
  falls back to a poll, and this document states that latency honestly rather than hiding it.
- Snapshot memory is bounded per repository, watched repositories are bounded per daemon, and the
  SSE fan-out is bounded per subscriber. Full patch text is never retained.
- Branch and HEAD changes produce a durable `project_updated` / `workspace_updated` event. Change
  counts and file lists ride on a live-only event that is never written to the durable log.

## Product Decisions

### Git state is derived, not owned

The repository on disk is the only source of truth. Rig caches a snapshot of it and publishes
changes. Nothing in Rig's behavior may depend on the cache being current, and a lost or stale cache
is always repairable by rescanning. This is why the detailed change state is deliberately _not_
durable: recomputing it costs one bounded `git diff`, while persisting it would grow the durable
event log without adding recoverable information.

The small, slow-moving facts — does the directory exist, is it a Git top level, which branch, which
commit — are persisted on the entity row, because clients list projects they are not currently
watching and expect a sensible answer without forcing a scan.

### Tracking is driven by an explicit watch set

Rig watches an entity when a client has explicitly asked it to, or when the entity has a live
session. Nothing else. In particular, appearing in a `/state` response does not make an entity
active: `/state` returns _every_ project, so that rule would mean "watch everything" and turn the
LRU cap into permanent churn.

Clients declare interest with `POST /git/watch` (below). Interest expires after five minutes unless
renewed, and the desktop renews what it is displaying. This is the primary reason the feature
scales; the byte caps are a second line of defense, not the first.

### "Changed" means everything that differs from the base

One number covers every kind of change at once: committed-since-base, staged, unstaged, and
untracked. There is no separate "staged" total, no separate "uncommitted" total, and no mode switch.
Per-file `staged` and `unstaged` flags are still reported, so a client that wants to distinguish
them can, but the headline totals never make the user choose.

One honest caveat that must be stated in the API docs: `git diff <base>` reports the _net_ state of
the working tree against the base. If a change is staged and then reverted in the working tree, the
net is zero and the file does not appear in the totals. It still appears in the file list with
`staged: true`, sourced from status rather than diff.

### The comparison base is an immutable commit, never a moving ref

A managed workspace's base is derived from the commit OID that existed when the workspace was
created, not from the _text_ of `baseRef`. `ProjectRepository` already resolves that OID at creation
time but throws it away, persisting only the ref text. This design persists it as `base_commit`.

```text
workspace: base = merge-base(base_commit, HEAD)
           if that fails      -> base = base_commit
           if that is missing -> no base; snapshot reports "comparison unavailable"
project:   base = HEAD
unborn:    base = the repository's empty tree, obtained from `git hash-object -t tree /dev/null`
```

Base resolution failure is never allowed to fall back to `HEAD`, because that renders a workspace's
committed work as an apparently clean tree — silently reporting zero for the exact case the feature
exists to measure. A workspace whose history has been rewritten out from under it reports an
explicit unavailable state.

The empty tree is obtained from Git rather than hardcoded, because the SHA-1 constant
`4b825dc642cb...` is wrong in a SHA-256 repository.

### Git output is parsed from machine formats, in one invocation per concern

The original plan was to use `simple-git` for status parsing and its numstat `diffSummary()` for
counts. Review killed the diff half of that and, with it, the justification for the dependency:

- `simple-git` refuses `-z` on `--numstat` and renders renames as an ambiguous `old => new` string,
  which forced a two-command index-zip. That zip is racy — two separate `git diff` processes over a
  tree the agent is actively mutating can produce equal-length outputs describing different files,
  attaching one file's counts to another with no way to detect it.
- Git itself has no such limitation. `git diff -z --raw --numstat --find-renames <base>` emits both
  the status letters and the counts from **one** tree walk, NUL-separated, with renames as two
  distinct path fields. Verified against real Git: a rename emits `0\t0\t\0old\0new\0` in the numstat
  block and `:...R100\0old\0new\0` in the raw block.
- `git status --porcelain=v2 -z --branch --untracked-files=all` likewise emits branch OID, head,
  upstream, ahead/behind, and every file record NUL-separated and unambiguously.

Both formats are documented, stable, machine-oriented, and NUL-safe. Parsing them is a field split,
not the quoting-and-escaping guesswork that makes porcelain v1 dangerous — and it is strictly safer
than a library that cannot express `-z`. Rig therefore adds no Git dependency and writes two small
parsers, each with fixture tests over real repositories.

(For the record: `simple-git@3.36.0` does bundle cleanly under Rig's esbuild config — 166 KB, leaving
only Node builtins and `supports-color`, which is already an accepted external. The dependency was
dropped on correctness grounds, not build grounds.)

### Scans must not execute repository-configured helpers

Reading a diff does not, by itself, run anything. That intuition is correct and it was measured
rather than assumed. Against a scratch repository with a `core.fsmonitor` hook, a `diff.external`
driver, and `.gitattributes` textconv drivers installed:

| Command                                                             | Helper executions                      |
| ------------------------------------------------------------------- | -------------------------------------- |
| `git diff -z --raw --numstat --find-renames <base>` — the scan diff | **0**                                  |
| `git status --porcelain=v2 -z --branch --untracked-files=all`       | **1** (`core.fsmonitor`)               |
| `git diff <base> -- <path>` — the patch endpoint                    | **3** (textconv, then `diff.external`) |

So the scan's diff is clean, and exactly two invocations are exposed. `--numstat`/`--raw` never
invoke textconv or an external diff driver even for binary files — they emit `-`/`-` instead.

The `status` case is not a hypothetical. It is the mechanism of **CVE-2021-43891** in VS Code and
**CVE-2022-24346** in JetBrains IDEs: an IDE runs `git status` automatically when a folder is opened,
Git spawns the `core.fsmonitor` program from `.git/config`, and merely opening a repository executes
attacker-controlled code. Neither vendor fixed this by sanitizing their Git invocations — VS Code
disabled the entire Git extension in untrusted workspaces, which is what Workspace Trust is for.

Rig cannot reuse that answer, because Rig has no trust prompt and the threat model is different.
Rig's exposure is a **sandbox escape**, not an untrusted-repository problem:
`createSandboxFilesystemConfig` deliberately makes `.git` writable in `workspace_write` and `auto`
so the agent can commit. An agent can therefore run `git config core.fsmonitor ./payload` with no
permission prompt at all, and the daemon — which is _not_ sandboxed — executes it on the next
automatic scan. Sandboxed code gets itself run unsandboxed, with no user action.

### Scans run inside Rig's own read-only sandbox

Enumerating the flags that disable each helper is whack-a-mole: it protects against the three
mechanisms measured today and against nothing Git adds later. Rig already owns a better answer, and
CLAUDE.md requires using it — every execution surface goes through the same shell sandbox, and a
background Git reader is an execution surface.

**Every scan and the patch endpoint run through `createSandboxedCommand` in `read_only` mode.** That
is seatbelt on macOS, bubblewrap on Linux, and `@anthropic-ai/sandbox-runtime` elsewhere. In
`read_only` the policy is `(deny default)` with `(allow file-read*)`, no writable roots, and no
network rule at all, so a helper Git spawns inherits a sandbox in which it can read and nothing else.

Measured, on a repository carrying a `core.fsmonitor` payload that appends to a log, writes a file,
and curls a URL:

|                                 | helper ran to effect | file written | network |
| ------------------------------- | -------------------- | ------------ | ------- |
| unsandboxed, no flags           | yes                  | yes          | yes     |
| sandboxed `read_only`, no flags | no observable effect | no           | no      |

The flags stay as well, because they are free and they stop the helper from being spawned at all
rather than spawning it into a cage:

```text
scan status:    git -c core.fsmonitor=false --no-optional-locks status ...
scan diff:      (already clean; carries the same -c for consistency)
patch endpoint: git ... diff --no-ext-diff --no-textconv ...
```

Two implementation requirements come out of measuring the cost, and both are load-bearing.

**Resolve the real Git binary once, at tracker construction.** On macOS `/usr/bin/git` is the
`xcrun` shim, which writes a cache file into `TMPDIR` on every invocation. Inside a sandbox with no
writable temp that write fails and the shim falls back to an expensive path resolution _every single
time_:

| Invocation                                       | Per run    |
| ------------------------------------------------ | ---------- |
| `git status`, unsandboxed                        | 11 ms      |
| sandboxed, `/usr/bin/git` shim, no writable temp | **409 ms** |
| sandboxed, resolved real Git binary              | 11 ms      |
| sandboxed, shim, temp writable                   | 14 ms      |

So the sandbox itself costs ~3 ms; the shim costs 400. The tracker resolves the Git executable once
(`xcrun --find git` on macOS, `PATH` lookup elsewhere), caches it, and invokes it directly.

**Add an argv entry point to the sandbox seam.** `createSandboxedCommand` builds a
`<shell> -lc <string>` command because its callers are shell tools. A background scan must not build
a shell string — CLAUDE.md forbids it for Git invocations — and must not source the user's login
profile on every scan. The measured cost of `zsh -lc` here was only ~3 ms, but that is this machine's
near-empty profile; a real developer profile is routinely hundreds of milliseconds. The scanner
therefore gets an argv-shaped variant of the same policy construction, sharing
`createSandboxFilesystemConfig`, `createMacOsSeatbeltCommand`, and `createLinuxBubblewrapCommand`
rather than forking a second security path.

On Windows the fallback spawns Node plus the sandbox-runtime CLI per invocation. At this design's
scan frequencies — debounced, single-flight, 30 s reconciliation — that is acceptable, and it is
called out here so it is measured rather than assumed.

Environment scrubbing remains as cheap hygiene inside the sandbox, not as the load-bearing part: it
stops an inherited `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_EXTERNAL_DIFF` from redirecting a scan and stops
credential prompts. Every scan invocation is therefore constructed as:

```text
env: inherit, minus GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, GIT_OBJECT_DIRECTORY,
     GIT_ALTERNATE_OBJECT_DIRECTORIES, GIT_CONFIG, GIT_CONFIG_GLOBAL, GIT_CONFIG_SYSTEM,
     GIT_CONFIG_COUNT/KEY/VALUE, GIT_EXTERNAL_DIFF, GIT_PAGER, GIT_EDITOR
     plus GIT_TERMINAL_PROMPT=0, GIT_ASKPASS=, GIT_OPTIONAL_LOCKS=0, GIT_NO_LAZY_FETCH=1,
     GIT_PAGER=cat, LC_ALL=C
args: git -C <path> --no-optional-locks
      -c core.fsmonitor=false -c core.hooksPath=/dev/null
      -c diff.external= -c core.askPass= -c credential.helper=
      <subcommand> --no-ext-diff --no-textconv ...
```

This is the same rule CLAUDE.md states for every other execution surface: feature differences may
change arguments, never the security path. A background reader that can be made to execute a program
the sandbox was supposed to contain is a hole in that path, regardless of how narrow it is.

`--no-optional-locks` is kept, with its real cost documented: it stops the scan from persisting a
refreshed index stat cache, so on a large repository every scan re-stats the tree. To recover the
cache without ever fighting the agent for `index.lock`, one lock-taking refresh scan is permitted
after an entity has had no dirty signal for 30 seconds.

## Domain Model

### Entity fields

```ts
type ProjectPresence = "present" | "missing";
type ProjectWorktreeSupport = "supported" | "unsupported" | "unknown";

interface Project {
    // existing fields
    presence: ProjectPresence;
    removedAt?: number;
    worktreeSupport: ProjectWorktreeSupport;
    worktreeSupportReason?: string; // human-readable, only when "unsupported"
    git?: GitRepositoryFacts;
}

interface ProjectWorkspace {
    // existing fields; `branch` is REMOVED, superseded by `git.branch`
    baseCommit?: string;
    presence: ProjectPresence;
    git?: GitRepositoryFacts;
}

interface GitRepositoryFacts {
    ahead: number;
    behind: number;
    branch?: string; // absent when detached or unborn
    detached: boolean;
    head?: string; // commit OID, absent on an unborn HEAD
    upstream?: string; // e.g. "origin/main"
}
```

`worktreeSupportReason` is display text, not an enum: "This folder is not a Git repository.", "This
folder is inside a Git repository but is not its root.", "This repository has no commits yet."

`ProjectWorkspace.branch` exists in the protocol today and has never been populated, because managed
worktrees are created `--detach`. Rather than shipping both it and a new `git_branch`, it is deleted
and replaced. CLAUDE.md's early-stage rule is explicit that obsolete fields are removed rather than
carried forward, and nothing reads it.

### Live change snapshot

```ts
type GitFileChangeStatus =
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "copied"
    | "type_changed"
    | "untracked"
    | "conflicted"
    | "submodule";

interface GitFileChange {
    binary: boolean;
    deletions?: number; // absent for binary, submodule, and uncounted files
    insertions?: number;
    path: string;
    previousPath?: string; // renames and copies
    staged: boolean;
    status: GitFileChangeStatus;
    unstaged: boolean;
}

type GitComparisonState = "ready" | "unavailable";

interface GitChangeSnapshot {
    base?: string;
    changedFiles: number; // total, even when `files` is truncated
    comparison: GitComparisonState;
    countsExact: boolean;
    deletions: number;
    error?: string; // human-readable, set for scan failure or unavailable comparison
    facts: GitRepositoryFacts;
    files: readonly GitFileChange[];
    filesTruncated: boolean;
    generation: string; // daemon run identity
    insertions: number;
    scannedAt: number;
    version: number; // monotonic per entity within one generation
}
```

`insertions` and `deletions` are totals across every changed file, including files omitted from
`files` by the truncation cap — _provided_ `countsExact` is true. Any cap that suppresses counting,
any truncated command output, and any failed count sets `countsExact: false`. The earlier claim that
a 16 MiB output cap still yields exact totals was simply false and is withdrawn.

`(generation, version)` is the snapshot identity. `generation` is the daemon run ID; `version` is a
counter held by `GitStateTracker` in a `Map<entityId, number>` that survives LRU eviction, so a
re-tracked entity never restarts at 1 and freezes a client. A client replaces its stored snapshot
when the generation differs, and otherwise only when the version is greater. Bootstrap and prelude
snapshots are unconditional replacements. This matters because `PersistentGlobalEventQueue`
deliberately reuses its stream ID across restarts, so a durable-mode client does _not_ get a `409`
to force a reload.

### Schema

Schema version 8. `initializeSessionDatabase.ts` has additive column-migration lists for `sessions`
and `queued_runs` only; this change introduces the same pattern for `projects` and
`project_workspaces`, adding each column both to the `CREATE TABLE` block and to a new
`PRAGMA table_info`-guarded ALTER list. `NOT NULL DEFAULT '<const>'` is valid for SQLite
`ADD COLUMN`.

```sql
-- projects and project_workspaces both gain:
presence TEXT NOT NULL DEFAULT 'present'
git_branch TEXT
git_head TEXT
git_upstream TEXT
git_ahead INTEGER NOT NULL DEFAULT 0
git_behind INTEGER NOT NULL DEFAULT 0
git_detached INTEGER NOT NULL DEFAULT 0

-- projects also gains:
removed_at_ms INTEGER
worktree_support TEXT NOT NULL DEFAULT 'unknown'
worktree_support_reason TEXT

-- project_workspaces also gains:
base_commit TEXT
-- and DROPS the unused `branch` column
```

No snapshot state is persisted.

## Startup Reconciliation

`PersistentSessionStore.#recoverProjectWorkspaces()` drives `ProjectRepository.reconcileGitFacts()`
**after** `reconcileInitializingWorkspaces()` and the `archiving` recovery loop, never before.
Archival recovery is user-visible correctness; presence probing is enrichment, and CLAUDE.md is
explicit that enrichment stays off the correctness path.

For every non-removed project and non-archived workspace, bounded at four concurrent probes:

```text
does path exist and is a directory?
    no  -> presence = "missing", worktreeSupport = "unsupported",
           reason = "This folder no longer exists."
    yes -> presence = "present"
           git rev-parse --show-toplevel
               != path -> worktreeSupport = "unsupported" + reason
               == path -> capture branch / HEAD / upstream / ahead / behind
                          worktreeSupport = "supported" unless HEAD is unborn or the repo is bare
```

Home projects are probed for presence only; `worktreeSupport` is permanently `"unsupported"` with
"Worktrees cannot be created from your home folder."

Each entity commits its own transaction and publishes only when a field actually changed, so an
unchanged restart produces no events. Probing never blocks daemon readiness and stops at `#closed`.

A missing directory is never auto-removed. It becomes `presence: "missing"`, which is what lets the
desktop offer a delete button.

## Removing a Project

```http
DELETE /projects/:projectId
If-Match: "<project version>"
```

- Allowed when the project has no live session and no workspace in a non-terminal state. `archived`
  and `archive_failed` workspaces do not block removal, because otherwise one stuck archive makes a
  project permanently unremovable.
- Never touches the filesystem.
- Sets `removed_at_ms` and, in the same transaction, rewrites `name_key` and `storage_key` to
  tombstone values derived from the row ID. Without this, an invisible removed row permanently
  squats the visible name and slug, so re-cloning `foo` elsewhere yields `foo (2)` forever. `path`
  stays intact and unique because revival is keyed on it.
- Terminally fences the project: pending initialization, presence probes, and any in-flight or
  queued scan are cancelled, and every such task re-checks `removed_at_ms IS NULL` before its final
  update. `ProjectRepository`'s initialization update currently has no such guard and gains one.
- Publishes `project_updated` with `removedAt` set. Clients hide removed projects.

Revival: resolving a session cwd that matches a removed project's path clears `removed_at_ms`,
re-reserves a name and storage key, and bumps the version — inside the _existing_ session-creation
transaction, publishing `project_updated` before `session_created`, preserving the current ordering
contract.

## Live Tracking

### Components

```text
GitStateTracker (one per daemon)
  ├── version counters   Map<entityId, number>, survives eviction
  └── RepositoryTracker (one per watched entity, LRU-capped)
        ├── watches      control-directory watches + platform working-tree backend
        ├── scheduler    debounce + single flight + backoff
        ├── generation   terminal-state guard checked before every side effect
        └── snapshot     immutable GitChangeSnapshot, bounded
```

### Lifecycle and shutdown ordering

This is where the first draft was wrong. Today `stopServer()` calls `taskDrain.beginClose()` and
`store.prepareForShutdown()` first, and the store is closed only in the outer `finally`. Disposing
the tracker in that `finally` would mean `drain()` waits on scans that have not been told to abort,
potentially for a full 10-second Git timeout.

Therefore: **`GitStateTracker.dispose()` runs inside `stopServer()`, before `taskDrain.beginClose()`.**
Disposal aborts every in-flight Git child, discards the queued-scan FIFO, closes every watcher, and
marks every tracker terminal.

LRU eviction has the same shape and the same fix: eviction aborts the in-flight scan, clears the
dirty-again bit, closes watchers, and marks the tracker terminal. Every publication, snapshot
mutation, and follow-up scheduling checks the tracker generation first, so an in-flight scan that
completes after eviction is discarded rather than publishing against closed watchers.

### Triggers

| Source                                                     | Latency        | Cost                          |
| ---------------------------------------------------------- | -------------- | ----------------------------- |
| Rig tool execution that may write                          | immediate      | none                          |
| Control-directory watches (below)                          | kernel         | ~4 directory watches per repo |
| `fs.watch(root, { recursive: true })` on macOS and Windows | kernel         | 1 handle per repo             |
| Reconciliation poll, always on                             | 30 s, jittered | 1 timer per repo              |
| Degraded working-tree poll where no kernel backend exists  | see below      | capped, jittered              |
| Client `GET .../git?refresh=1`                             | immediate      | none                          |

**Control-directory watches must watch directories, not files.** Git replaces `HEAD`, `index`, and
`packed-refs` by writing a lockfile and renaming it over the target. `fs.watch` on a file follows the
inode, so after the first commit the watch is attached to a dead inode and every later commit is
invisible. The first draft's four file watches would have failed its own acceptance scenario. Rig
instead watches the _containing directories_ and filters by entry name:

```text
<gitdir>                     -> HEAD, index, MERGE_HEAD, REBASE_HEAD  (per-worktree state)
<commondir>                  -> packed-refs, config
<commondir>/refs/heads       -> recursive; loose refs for `feature/x` live in subdirectories
<commondir>/refs/remotes     -> recursive; otherwise `git fetch` leaves ahead/behind stale
```

For a linked worktree, per-worktree `HEAD` lives in `<commondir>/worktrees/<name>` while branch and
remote refs live in the common directory. Both are resolved with
`rev-parse --path-format=absolute --git-dir --git-common-dir`; `findGitWritablePaths.ts` already does
this resolution and is the reference.

Node's `fs.watch` does not surface inotify's `IN_Q_OVERFLOW`, so "rearm on overflow" is not
implementable at this abstraction level and is not claimed. That is precisely why the **30-second
reconciliation poll runs unconditionally, even when every watcher looks healthy.** It is the
completeness guarantee; the watches are the latency optimization.

### The working-tree backend, and the Linux question

`watchRepositoryTree(root, onDirty)` has three backends: kernel-recursive (macOS, Windows), filtered
per-directory inotify (Linux), and none. Both reviewers pushed back hard on the Linux backend, and
they were right on the numbers even though the first draft's measurement was sound.

The measurement stands: in Rig's own working checkout there are 7450 directories, 6255 of them under
`node_modules`, against 171 directories containing tracked files. Skipping ignored directories really
is a ~37× reduction, and Node's own recursive mode — which cannot be told to skip anything — really
would arm ~7450 watches per repository.

What the first draft got wrong is what that reduction buys at the cap. 200 watches × 32 entities is
6528 watches, which is 80% of an 8192 `max_user_watches` budget — a budget shared with the user's
editor and language servers. "Comfortably inside" was wrong. And the implementation is not the
250–300 lines estimated: nested `.gitignore`, `info/exclude`, `core.excludesFile`, tracked files
under ignored directories, mkdir-during-walk races, subtree moves, sparse checkouts, submodules, and
watch-limit exhaustion put it realistically at 600–1100 lines plus a comparable body of
Linux-specific tests. Both reviewers independently landed on 2–4 engineer-weeks.

**Decision: the Linux inotify backend is deferred out of v1.** Not because it is impossible, but
because its cost/benefit is poor once the other triggers are correct. With directory-based control
watches, commits, checkouts, branch switches, rebases, and fetches are at kernel latency on _every_
platform. Rig's own writes cover agent activity everywhere. The Linux backend would improve exactly
one case: a user hand-editing files in their own terminal on Linux, in a repository Rig is already
watching. That case is served by the poll, and the honest latency is stated below rather than hidden.

If the Linux backend is later shown to be needed, it goes behind the same
`watchRepositoryTree` seam, with a per-repository watch cap and a daemon-wide watch budget that
degrades to polling on exhaustion. Adopting `@parcel/watcher` is then also a legitimate option —
Rig already ships native externals (`sharp`, `node-pty`), so "no native watcher" is a preference,
not a constraint.

Polling, with the arithmetic the reviews demanded:

- The **reconciliation poll** is 30 s ± jitter for every watched entity. At the 32 cap that is
  ~1.07 scans/s, two Git processes each: ~2.1 process launches/s. Acceptable.
- The **degraded working-tree poll** applies only where no kernel backend exists. It is 2 s for the
  single entity attached to the session that most recently produced output, 15 s ± jitter for other
  entities with a live session, and never for entities that are merely client-watched — those rely
  on the 30 s reconciliation and on `?refresh=1`.
- Degraded pollers are capped at 4 concurrently. The first draft's "3 s for all 32" would have meant
  ~10.7 scans/s and ~21 Git launches/s, permanently saturating the scan pool at any scan duration
  over 375 ms. That is withdrawn.

Stated plainly, the Linux latency for a user's own terminal edit is up to 2 s plus debounce when a
session is live, and up to 30 s otherwise. Everything else is at kernel latency.

### Scheduling

- Debounce 150 ms, maximum delay 750 ms.
- Single flight per entity; a trigger during a scan sets a dirty-again bit and schedules exactly one
  follow-up.
- Global cap of four concurrent scans, FIFO queue, discarded when the tracker is terminal or the
  `TaskDrain` is closing.
- Scan failure sets `error`, publishes it, and backs off exponentially from 1 s to 30 s.
- Scans never run inside a SQLite transaction.

### The scan

Two invocations, both with the sanitized environment above, a 10 s timeout, an output cap, and an
abort signal:

```text
1. git status --porcelain=v2 -z --branch --untracked-files=all
       -> branch.oid, branch.head, branch.upstream, branch.ab
       -> per-file XY codes: staged/unstaged flags, untracked ('?'), unmerged ('u')
2. resolve base (see "The comparison base" above)
3. git diff -z --raw --numstat --find-renames --no-ext-diff --no-textconv <base>
       -> ONE tree walk producing both status letters and counts, NUL-separated,
          renames as two distinct path fields
4. untracked files: count lines directly, bounded
5. sort by path, apply caps, compare with the previous snapshot
```

Consistency fence: the scan records `branch.oid` plus the index file's size and mtime before step 3
and re-reads them after step 4. If either changed, the tree moved under the scan and the result is
discarded and rescanned rather than published. This replaces the first draft's index-zip, which had
no way to detect that two commands had seen different trees.

Counting rules, corrected from the first draft:

- Untracked line counts follow Git's definition: a final line without a trailing newline still
  counts as one line. Counting newline bytes alone reports 0 for a one-line file with no trailing
  newline.
- Binary classification for tracked files comes from Git's own `-` / `-` numstat rows, not from our
  sniffing. Sniffing is used only for untracked files, and its limitation — it does not honor
  `.gitattributes` or custom diff drivers — is stated rather than papered over.
- Submodule pointer changes are reported as `status: "submodule"` with no line counts. Rig does not
  recurse into submodule working trees, and therefore does **not** pass
  `--ignore-submodules=dirty`, which would hide the pointer change too. A dirty submodule working
  tree is out of scope and documented as such, rather than silently folded into "everything that
  differs".
- Unreadable, vanished, special, and symlinked untracked files are skipped without blocking and set
  `countsExact: false`.
- Merge and rebase conflict states are reported from status `u` records as `status: "conflicted"`.
  Conflict-marker text inflates insertion counts; this is Git's own behavior and is left alone, but
  conflicted entities set an explicit flag so a client can choose not to show a total mid-merge.

An unchanged scan publishes nothing. Equality is structural over the snapshot excluding `scannedAt`,
`version`, and `generation`; the version is incremented only after a semantic difference is found.

### Bounds

| Bound                        | Value  | Behavior at the limit                                        |
| ---------------------------- | ------ | ------------------------------------------------------------ |
| Files in `files`             | 1000   | `filesTruncated: true`; totals stay exact                    |
| Diff output                  | 16 MiB | scan aborts, `countsExact: false`, totals are best-effort    |
| Untracked files line-counted | 200    | remainder counts as changed files only; `countsExact: false` |
| Untracked file size counted  | 1 MiB  | larger files reported without line counts                    |
| Watched entities             | 32     | LRU eviction, logged through `DaemonLog`                     |
| Concurrent scans             | 4      | FIFO queue                                                   |
| Degraded pollers             | 4      | others fall back to the 30 s reconciliation                  |
| Per-subscriber SSE backlog   | 1 MiB  | subscriber disconnected with a readable reason               |

Worst-case retained snapshot memory is ~1000 files × ~120 bytes × 32 entities ≈ 4 MB. Patch text is
never retained.

## Events and Synchronization

### Two channels

- **Durable.** Branch, HEAD, upstream, ahead/behind, detached, presence, worktree support, removal,
  base commit. Persisted on the entity row, published with the existing `project_updated` /
  `workspace_updated` events. A branch change is a durable update.
- **Live.** The change snapshot, published as a live-only event.

```ts
type ProjectGitEvent = BaseProjectEvent<"project_git_changed", { git: GitChangeSnapshot }>;
type ProjectWorkspaceGitEvent = BaseProjectWorkspaceEvent<
    "workspace_git_changed",
    { git: GitChangeSnapshot }
>;
```

Both are published only after any durable fact change from the same scan has committed, so a client
never sees a file list attributed to a branch it has not been told about.

### Live-only has to be a real API, not a flag

The first draft said the queue would "gain a classification" for events that are neither stored nor
cursor-advancing. Against the real code that has no legal representation:

- `GlobalEventQueueEntry` requires a `cursor`, and `writeGlobalSseEvent` emits it as the SSE `id:`,
  which clients echo back as `Last-Event-Id`. A fabricated or reused cursor corrupts reconnect.
- `PersistentSessionStore.#publishGlobalEvent` treats `append() === undefined` as _do not publish_,
  so implementing the classification inside `append` would silently swallow every snapshot in both
  modes.
- `streamGlobalEvents` receives only the queue, so a "prelude of current snapshots" has nowhere to
  come from.

So the contract changes explicitly:

- `GlobalEventQueue` gains `publishLive(event: GlobalEvent): void`, which delivers to current
  subscribers and never stores, never allocates a cursor, and never advances one. Both
  implementations implement it identically.
- The subscriber callback receives a discriminated value: a stored `GlobalEventQueueEntry`, or a
  live `{ event }` with no cursor. `writeGlobalSseEvent` omits the `id:` line for live values, so a
  client's `Last-Event-Id` always remains the last durable cursor.
- `shouldPublishGlobalEvent` is extended so git events can never be routed into the durable log.
- `streamGlobalEvents` takes a `liveSnapshots()` callback supplied by `createProtocolHttpServer`,
  which has tracker access. It **subscribes first, then captures snapshots, then dedupes by
  `(generation, version)`** — capture-then-subscribe would drop a snapshot published in the gap.

### Backpressure

`writeGlobalSseEvent` currently ignores `response.write()`'s return value, and the subscriber set is
uncapped. Snapshots make that materially worse: at the documented maxima, 32 entities publishing
~120 KiB every 750 ms is ~5 MiB/s per slow client, buffered in the daemon.

Live snapshot delivery is therefore coalesced per subscriber: while a socket has not drained, at
most one pending snapshot per entity is retained and later ones replace it. Durable events are never
coalesced or dropped. A subscriber whose pending buffer exceeds 1 MiB is disconnected with a
readable reason and reloads from `/state`.

## HTTP API

```text
POST   /git/watch                                    -> declare/renew interest, 5 minute TTL
GET    /projects/:projectId/git                      -> { git: GitChangeSnapshot }
GET    /projects/:projectId/workspaces/:id/git       -> { git: GitChangeSnapshot }
GET    /projects/:projectId/git/diff?path=<path>     -> text/plain patch, bounded
DELETE /projects/:projectId                          -> remove a project record
```

- `POST /git/watch` takes an entity list, marks them watched for five minutes, and returns their
  current snapshots. This is the demand signal; the desktop renews it for what it displays.
- `GET .../git` returns the cached snapshot when one exists and otherwise performs one scan.
  `?refresh=1` forces a scan and awaits it.
- The diff endpoint runs `git diff --no-ext-diff --no-textconv <base> -- <path>` with a 1 MiB cap
  and `413` beyond it, streamed, never cached.
- `POST /projects/:projectId/refresh` also re-probes presence, worktree support, and Git facts.
- `GET /state` gains `gitSnapshots` for watched entities only.

## Failure and Recovery

- **`git` missing.** Every project probes to `worktreeSupport: "unsupported"` with a readable reason,
  tracking is disabled, one diagnostic is recorded, nothing else degrades.
- **Unborn HEAD.** `head` absent, base is the repository's empty tree, everything reads as added,
  `worktreeSupport: "unsupported"` until the first commit.
- **Detached HEAD or unrelated history in a workspace.** `comparison: "unavailable"` with a readable
  error, never a silent clean tree.
- **Directory disappears while watched.** The next scan fails with ENOENT, the entity flips to
  `presence: "missing"` durably, and tracking stops.
- **Watch-limit or descriptor exhaustion.** That repository's working-tree backend degrades to
  polling; control watches and reconciliation continue.
- **Daemon shutdown mid-scan.** Tracker disposal precedes the drain, so children are killed before
  anything waits on them.
- **Durable restart.** The queue reuses its stream ID, so the snapshot `generation` changes and
  clients replace unconditionally.

## Security and Resource Boundaries

- Every Git invocation runs through `createSandboxedCommand` in `read_only` mode, with an argument
  array and the sanitized environment above; no shell string, no inherited Git redirection, no
  writable path, no network, and any helper Git spawns inherits the same cage.
- The only client-supplied value reaching Git is the diff endpoint's `path`: passed after `--`, must
  not begin with `-`, must contain no NUL, must resolve inside the entity's working tree.
- Comparison bases are OIDs Rig resolved itself, never client text.
- Watches are armed only inside the entity's working tree and its resolved Git directories; symlinked
  roots are rejected as workspace deletion already rejects them.
- Untracked reads are bounded, non-blocking, and do not follow symlinks.
- Scan output, snapshot size, entity count, concurrency, backoff, poller count, and per-subscriber
  buffering are all capped above.

## Implementation Plan

### Task 1: Presence, worktree capability, base commit, and project removal

Schema version 8 including the new project-column migration lists, the `branch` → `git_branch`
replacement, `base_commit` persistence at workspace creation, `reconcileGitFacts()`, its placement
after workspace recovery, `DELETE /projects/:projectId` with tombstoning and terminal fencing, and
revive-on-resolve inside the session-creation transaction. Durable events only.

### Task 2: The sandboxed Git runner and the two parsers

`runScanGit.ts` (argv sandbox entry point in `read_only`, resolved Git executable, environment
sanitization, caps, abort), `resolveGitExecutable.ts`, `parseGitStatusV2.ts`,
`parseGitRawNumstat.ts`. Fixture tests over real temporary repositories: staged, unstaged,
untracked, binary, renamed, copied, deleted, type-changed, conflicted, submodule pointer,
committed-ahead-of-base, unborn HEAD, SHA-256 repository, paths with spaces, quotes, `=>`, and
non-UTF-8 bytes.

### Task 3: The scanner

`scanGitRepository.ts` with base resolution, the consistency fence, untracked counting, caps, and
snapshot equality. Tests assert every cap sets `countsExact: false` and that a tree mutated mid-scan
is rescanned rather than published.

### Task 4: The tracker

`GitStateTracker` with the watch set, LRU, version map, debounce, single flight, backoff, terminal
generations, control-directory watches, reconciliation poll, and the capped degraded pollers. Wire
disposal into `stopServer()` before the drain. Tests: branch ref replacement, slashed branch names,
fetch updating ahead/behind, eviction during publication, disposal during an active scan.

### Task 5: Events and API

`publishLive`, the live subscriber value, `id:`-omitting SSE, per-subscriber coalescing and the
1 MiB ceiling, the subscribe-then-capture prelude, `/state` snapshots, and the four endpoints.
Tests: durable branch update ordered before the live snapshot from the same scan, a reconnecting
client with a valid cursor after a restart, and a slow consumer.

### Task 6: Rig's own write signal

Mark the entity dirty after any tool execution that is not read-only, derived from **each tool
definition's own declaration** — never a tool-name list, per CLAUDE.md's permission-ownership rule.
Best effort; it must never fail a run.

### Task 7: End-to-end verification

Gym coverage for: agent edit producing the expected snapshot; commit producing a durable HEAD
update; durable restart with a generation change; a slow SSE consumer; watcher degradation;
disposal during an active scan; merge conflict; and project deletion racing session creation.

## Acceptance Scenarios

1. An agent edits three files in a managed workspace. Within one second a client sees
   `changedFiles: 3` with correct per-file counts.
2. The user switches branches in their own terminal. The directory watch fires, a durable
   `workspace_updated` carries the new branch, and a live snapshot carries the recomputed diff.
   Repeating this ten times keeps working — the watch is on the directory, not a dead inode.
3. The agent commits. The base is derived from the persisted `base_commit`, so the totals do not
   drop to zero.
4. `main` is force-pushed out from under a workspace. The snapshot reports
   `comparison: "unavailable"` with a readable message, not zero.
5. A build writes 40,000 untracked files. Scans coalesce, `files` truncates at 1000,
   `filesTruncated` is true, and `countsExact` is **false** — because the untracked cap was hit.
6. A project folder is deleted outside Rig. After restart it is `presence: "missing"`, `DELETE`
   removes the record without touching disk, and re-cloning it elsewhere is named `foo`, not
   `foo (2)`.
7. An agent writes a `core.fsmonitor` hook into `.git/config` — which the sandbox permits, because
   `.git` must stay writable for commits. The next automatic scan does not execute it, and neither
   does the patch endpoint with a `diff.external` or textconv driver installed. With the flags
   removed in a test, the payload still cannot write a file or reach the network, because the scan
   itself ran in the read-only sandbox.
8. A scan of a warm repository completes in roughly the same time sandboxed as unsandboxed, because
   the tracker invokes the resolved Git binary rather than the macOS `xcrun` shim.
9. The daemon runs an hour with the durable queue and heavy editing; the durable event table grows
   only by branch and HEAD updates.

## Deliberate Non-goals

- Holding patch text in memory or streaming full patches as events.
- Persisting the change snapshot.
- Watching entities nobody asked for.
- A Linux inotify working-tree backend in v1, and Watchman in any version.
- Recursing into submodule working trees.
- Per-hunk state, staging, or any write operation against Git.
- Displaying Git state in the Rig TUI. This design delivers daemon state and API surface only.

## Reviews

Two independent adversarial reviews were run against revision 1 of this document and the current
Rig code: Anthropic `fable-5` (verdict: approve with changes, five blockers) and OpenAI `gpt-5.6-sol`
(verdict: reject, ten blockers). Their findings agreed on five points and each caught things the
other missed. Everything below was incorporated above:

Agreed blockers: single-file control watches die on Git's lockfile-rename; "live-only" events have
no legal representation in the real queue API; the two-command index-zip is racy; snapshot versions
reset and freeze clients; `/state` membership is not a usable activity signal; the schema section
misdescribed the real migration code and collided with `project_workspaces.branch`; soft-deleted
rows squat unique keys.

Caught only by `fable-5`: `refs/heads` subdirectories for slashed branch names; the
`--no-optional-locks` stat-cache cliff; the `archive_failed` deadlock in project removal; the
requirement that the write signal derive read-only-ness from tool definitions rather than a name
list; startup ordering against archival recovery.

Caught only by `gpt-5.6-sol`: **Git executing repository-configured helpers from the unsandboxed
daemon** — the most serious finding. Its scope was overstated and has been narrowed by measurement:
the scan's `--raw --numstat` diff executes nothing, and only `git status` (`core.fsmonitor`) and the
patch endpoint (textconv, `diff.external`) are exposed. The finding stands regardless, because the
`status` path is the CVE-2021-43891 mechanism and, under Rig's sandbox, is a genuine escape rather
than an untrusted-repository risk. Also: the base ref being mutable while only its text is
persisted; the hardcoded SHA-1 empty tree failing in SHA-256 repositories; the false "exact totals
under a 16 MiB cap" claim; newline counting versus Git's line definition; unbounded SSE buffering
without `write()` backpressure; the shutdown-ordering conflict between tracker disposal and the task
drain; `--ignore-submodules=dirty` contradicting the stated scope.

Both reviewers rejected revision 1's Linux watcher estimate. Revision 1 claimed 250–300 lines and
"comfortably inside" the watch budget; both independently arrived at 600–1100 lines, 2–4
engineer-weeks, and ~80% consumption of an 8192-watch budget at the entity cap. That estimate is
accepted and the backend is deferred.

## Research Notes

- `git status --porcelain=v2 -z --branch --untracked-files=all` emits `# branch.oid`, `# branch.head`,
  `# branch.upstream`, `# branch.ab`, then `1`/`2`/`u`/`?` records. Verified: rename records (`2`)
  consume two NUL-separated path fields, which the parser must account for.
- `git diff -z --raw --numstat --find-renames <base>` emits the raw block and the numstat block from
  one invocation. Verified: a rename appears as `:...R100\0old\0new\0` in raw and `0\t0\t\0old\0new\0`
  in numstat — no `=>` string parsing anywhere.
- `simple-git@3.36.0` rejects `-z` on numstat with "Summary flag --numstat parsing is not compatible
  with null termination option '-z'". Verified.
- Node's `fs.watch` on a file follows the inode; Git's lockfile-plus-rename update pattern therefore
  breaks single-file watches after the first update.
- libuv keeps one inotify fd per event loop, so per-directory watches cost inotify _watches_, not
  file descriptors. The scarce resource is `fs.inotify.max_user_watches` (8192 on older kernels).
- `4b825dc642cb6eb9a060e54bf8d69288fbee4904` is Git's SHA-1 empty tree and is wrong under SHA-256;
  `git hash-object -t tree /dev/null` yields the correct one for the repository.
- `findGitWritablePaths.ts` already resolves the `gitdir:` pointer file and `commondir`, which is the
  resolution the control-directory watches need.
- Helper execution was measured, not assumed, against a repository carrying a `core.fsmonitor` hook,
  a `diff.external` driver, and `.gitattributes` textconv drivers. `diff --raw --numstat`: zero
  executions, including for binary files. `status --porcelain=v2`: one, from fsmonitor, and
  `--no-optional-locks` does _not_ suppress it. Plain `diff <base> -- <path>`: three, from textconv
  and then `diff.external`. `-c core.fsmonitor=false` plus `--no-ext-diff --no-textconv` brings all
  three to zero.
- CVE-2021-43891 (VS Code < 1.63.1) and CVE-2022-24346 (JetBrains < 2021.3.1) are the same
  fsmonitor-on-automatic-`git status` mechanism. VS Code's fix was to disable the Git extension in
  untrusted workspaces rather than to harden the invocation.
- Sandbox cost and the shim trap were measured on macOS with the seatbelt policy Rig already
  generates: `sandbox-exec` around `/usr/bin/true` costs ~5 ms, but `git status` went from 11 ms
  unsandboxed to 409 ms sandboxed. The cause is `/usr/bin/git` being the `xcrun` shim failing to
  write `TMPDIR/xcrun_db-*`; using the resolved real binary restores 11 ms, and granting a writable
  temp gives 14 ms.

### Pre-existing issue found while measuring

`createMacOsSeatbeltCommand` sets `writableCandidates = []` for `read_only`, so the seatbelt policy
grants no writable temp at all, while `createSandboxFilesystemConfig` — used by the non-seatbelt
fallback — always includes `temporaryDirectory` even in `read_only`. The two sandbox backends
therefore disagree about temp.

The consequence is not limited to this design: on macOS in Read-only mode, _any_ agent command that
goes through an `xcrun` shim — `git`, `clang`, `swift` — pays the same ~400 ms penalty per
invocation today. This is worth fixing independently of Git tracking, by granting `read_only` a
writable temporary directory in the seatbelt policy so both backends agree.
