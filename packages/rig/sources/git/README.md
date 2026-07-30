# git

Everything Rig knows about a Git repository: how it runs Git, what it reads back,
how it parses that output, how it watches a repository for change, and how it
creates and removes the managed worktrees a workspace lives in.

Nothing in here decides what a project or a workspace _is_. That belongs to
`project/ProjectRepository`, which orchestrates lifecycle and persists the result;
this module answers Git questions and performs Git actions, and returns typed
values. It holds no database code and no HTTP code.

```
   project (ProjectRepository) + server (HTTP routes, daemon)
                     |
                     v
   +---------------------------------------------------------------+
   |                             git                               |
   |                                                               |
   |   execution        runGitCommand         foreground, direct   |
   |                    runSandboxedGitCommand background, caged   |
   |                    runScanGit            one read-only scan   |
   |                    resolveGitExecutable  the real binary      |
   |                          |                                    |
   |                          v                                    |
   |   reading          readGitTopLevel                            |
   |                    readGitCommonDir                           |
   |                    readGitWorktreeIdentity                    |
   |                    resolveGitCommit                           |
   |                    selectGitRemoteUrl                         |
   |                    probeGitRepository   presence + facts      |
   |                                                               |
   |   worktrees        createGitWorktree                          |
   |                    removeGitWorktree                          |
   |                    isGitWorktreeAt                            |
   |                                                               |
   |   change tracking  GitStateTracker  --> scanGitRepository     |
   |                          |                     |              |
   |                          |                     +--> parseGitStatusV2
   |                          |                     +--> parseGitRawNumstat
   |                          |                     +--> resolveGitComparisonBase
   |                          |                     +--> countUntrackedFileLines
   |                          v                                    |
   |                    watchGitRepositoryChanges                  |
   |                                                               |
   |   identity         remoteProjectName                          |
   |                    parseHostingRepository                     |
   +---------------------------------------------------------------+
```

## Running Git

Every operation here takes a `GitCommandRunner` rather than executing Git itself,
so the caller chooses the execution surface and a test can replace it wholesale.

`runGitCommand` is the foreground surface. It runs Git directly, with a timeout
and an output ceiling, and backs the actions a user asked for: creating and
removing a worktree, which Git cannot do read-only.

`runSandboxedGitCommand` is the background surface, layered on `runScanGit`. An
unattended read runs in the daemon, outside any session's permission review,
against a `.git` directory an agent is allowed to write; running it under
`read_only` means a helper program Git might spawn inherits a cage instead of the
daemon's privileges. `runScanGit` also strips the environment variables and
repository configuration that would redirect a read or make it execute a helper.

`resolveGitExecutable` finds the real binary once per daemon, because on macOS
`/usr/bin/git` is an `xcrun` shim that costs hundreds of milliseconds per call.

## Reading a repository

`readGitTopLevel` and `readGitCommonDir` normalize their answers so they can be
compared with a path Rig already holds; `readGitWorktreeIdentity` returns both,
which together answer "is this directory the worktree we recorded".
`isGitWorktreeAt` turns that into the yes/no a caller needs to decide whether a
directory can be adopted or must be rebuilt.

`probeGitRepository` reads the slow-moving facts - does the folder exist, can a
worktree be created from it, which branch and commit is it on. A probe is
enrichment, so every Git failure becomes "not a usable repository" rather than an
error.

`selectGitRemoteUrl` picks the remote that best describes the repository, in a
stable order: the remote the current branch tracks, then `origin`, then the rest
in Git's own order. `remoteProjectName` and `parseHostingRepository` turn that URL
into a display name and into a forge coordinate.

## Worktrees

A worktree is always created as a branch, so `createGitWorktree` creates the
branch with it and then proves Git did what was asked: Git resolves the
destination itself and will place a worktree somewhere Rig did not intend.
`removeGitWorktree` checks that the repository still reports the recorded control
directory before it force-removes anything, and always prunes, because a missing
directory is exactly the case where a stale administrative entry remains.

## Tracking change

`GitStateTracker` owns the live picture of what has changed in the repositories
someone is looking at. It debounces, bounds how many repositories it tracks,
polls on an interval because a watch cannot promise completeness, and publishes a
snapshot only when something actually differs. `watchGitRepositoryChanges` is the
latency optimisation underneath it, and `scanGitRepository` produces the snapshot
by running one status and one diff and parsing them.

`markGitStateFromSessionEvent` feeds the tracker from Rig's own activity, which is
the cheapest change signal available and the only one that works everywhere.
`publishGitLiveEvent` delivers a snapshot to both the live stream and the global
event queue.

## Layout

```
git/
    index.ts                     the module's public shape
    types.ts                     GitCommandRunner
    runGitCommand.ts             direct execution
    runSandboxedGitCommand.ts    sandboxed execution
    runScanGit.ts                one sandboxed read-only Git command
    resolveGitExecutable.ts      the real Git binary, resolved once
    readGitTopLevel.ts           working-tree root
    readGitCommonDir.ts          shared control directory
    readGitWorktreeIdentity.ts   both of the above together
    isGitWorktreeAt.ts           is this the worktree we recorded
    resolveGitCommit.ts          reference to immutable commit
    selectGitRemoteUrl.ts        which remote describes this repository
    probeGitRepository.ts        presence, worktree capability, facts
    createGitWorktree.ts         create a worktree on its own branch
    removeGitWorktree.ts         remove a worktree and prune
    GitStateTracker.ts           live change state for tracked repositories
    scanGitRepository.ts         one change snapshot
    watchGitRepositoryChanges.ts filesystem watches for a repository
    countUntrackedFileLines.ts   insertions a new file would add
    parseGitStatusV2.ts          porcelain v2 status output
    parseGitRawNumstat.ts        raw + numstat diff output
    resolveGitComparisonBase.ts  what a snapshot is measured against
    resolveGitTrackedEntity.ts   project or workspace tracking identity
    markGitStateFromSessionEvent.ts  agent activity as a change signal
    publishGitLiveEvent.ts       deliver a snapshot to subscribers
    remoteProjectName.ts         project name from a remote URL
    parseHostingRepository.ts    forge, owner, repository from a remote
    tests/                       tests for the files above
```
