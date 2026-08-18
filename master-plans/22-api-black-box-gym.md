# Master plan 22: Happy Agent API black-box gym

## Big picture

The new Happy Agent HTTP API must be proven as a complete product boundary, not
as a collection of route unit tests. A real daemon starts in the Rig gym, a real
`HappyAgentClient` talks to it over the public Unix-socket HTTP API, and the
tests observe only public responses, streams, terminal behavior, and resulting
filesystem or process effects. They never reach into modules, storage, or
daemon internals to make a scenario pass.

This begins only after the current API and module migration is finished,
verified, committed, rebased onto `origin/main`, and pushed to `main`. There is
no legacy API lane and no compatibility suite: the contract under test is the
new API only.

## Freeze the contract first

Before test implementation, make one coverage ledger that assigns every public
client method and HTTP path to exactly one test lane. For each entry it records
the response, stable errors, emitted events and their order, resource-version
transition, mutation echo, real system effect, restart expectation, and whether
the corresponding legacy route must be absent. No entry may be unowned or owned
twice.

The ledger is also the contract gate. A disagreement between `API.md`, a master
plan, and direct human direction is a blocker to be resolved by the human
before tests encode either answer. Test agents never edit `API.md`.

The direct product direction to preserve is:

A project is the root workspace of its file tree. Projects and workspaces each
own their own ordered series of top-level agents in the same way. A project ID
is its root-workspace ID; a child workspace owns a separate series. There is no
global agent-list endpoint. Workspace parent and child relationships describe
files, checkouts, and branches only. Subagent ancestry belongs only to Agent
Base. Only user steering emits `run.boundary`; queued and incoming messages,
notifications, and compaction do not.

The gym must prove both ordinary success and deliberate failure. A project is
registered or cloned, workspaces are created and nested, ordering and archival
are durable, and invalid paths, impossible workspace operations, stale
versions, conflicts, and failed initialization settle honestly without
duplicates or corrupted catalogs.

## The public harness

Every scenario owns the short root `.local/g/<run>/<instance>` so Unix socket
paths remain comfortably below platform limits. The IDs are unique across
workers, and every database, home, socket, workspace, fixture, log, and process
owned by that scenario stays beneath its bounded root. The daemon, fixtures,
and adapters run in the same unprivileged container namespace and connect
directly through the real Unix socket.

Ordinary JSON and SSE travel through `HappyAgentClient`. A small raw
Unix-socket harness may be used only for authentication and header probes,
terminal WebSocket attachment, and `CONNECT` tunnels, unless those transports
become public client capabilities. The WebSocket and `CONNECT` adapters derive
their endpoints from client URLs and contain transport only, never product
logic or a parallel raw REST client. The only other raw probes are unknown
routes and exact authentication or header behavior.

Inference is the only mock. HTTP, SSE, WebSockets, `CONNECT`, PTYs, SQLite,
files, Git, processes, restart, and their effects are real. Hermetic loopback
fixtures provide smart-HTTP Git remotes and controlled HTTP and TCP services;
there are no external services, credentials, privileged setup, or test-only
daemon endpoints.

Cleanup has explicit time and size bounds. Every test waits for observable
state through event predicates rather than sleeps, then disposes clients,
streams, WebSockets, tunnels, terminals, processes, the daemon, sockets, and
its `.local` root. Failure cleanup is the same as success cleanup, so
interrupted runs cannot poison later tests.

## Proof rules

Every successful mutation proves the response, the complete ordered event
sequence, and the real system effect together. It then proves the resource can
be read back, and when durable, survives daemon restart in the documented
state.

Every rejected mutation proves the status and stable error code, any
authoritative current resource in the error, that no system effect occurred,
that no change event was emitted, and that the same client can continue using
the daemon. This includes two-client races over versions, answers, ordering,
and run guards. Reusing a `mutationId` must prove it is an echo only, never a
deduplication key.

Snapshot and stream tests prove that bootstrap's cursor closes the snapshot
window, pulls honor `after`, `until`, ordering, and limits, SSE resumes without
duplicates, a lost cursor produces the documented pull error or live-stream
gap hello, slow consumers stay bounded, and resync converges. Restart tests
prove the ledger's expectation for every durable and runtime resource instead
of assuming that all state has the same lifetime.

## Ordered work

**A. Establish the shared boundary sequentially.** After two GPT-5.6 Sol agents
at extra-high reasoning independently expand and critique the coverage ledger,
one owner reconciles it and builds the harness. No parallel API test work
starts before the ledger and harness are green and frozen. This lane alone owns
the shared harness.

**B. Build large exclusive lanes.** GPT-5.6 Luna agents at maximum reasoning
take the lanes below. A lane may create and edit only its one named test file.
Every command is independently runnable from the repository root:

| Lane                   | Exclusive test file                          | Targeted command                                                                                 |
| ---------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Platform               | `tests/happy_api_platform.test.ts`           | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_platform.test.ts`           |
| Environment            | `tests/happy_api_environment.test.ts`        | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_environment.test.ts`        |
| Projects               | `tests/happy_api_projects.test.ts`           | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_projects.test.ts`           |
| Workspaces             | `tests/happy_api_workspaces.test.ts`         | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_workspaces.test.ts`         |
| Files and Git          | `tests/happy_api_files_git.test.ts`          | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_files_git.test.ts`          |
| Terminals and proxy    | `tests/happy_api_terminal_proxy.test.ts`     | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_terminal_proxy.test.ts`     |
| Agent catalogs         | `tests/happy_api_agent_catalog.test.ts`      | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_agent_catalog.test.ts`      |
| Transcript and runs    | `tests/happy_api_transcript_runs.test.ts`    | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_transcript_runs.test.ts`    |
| Questions and activity | `tests/happy_api_questions_activity.test.ts` | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_questions_activity.test.ts` |
| Sync and concurrency   | `tests/happy_api_sync_concurrency.test.ts`   | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_sync_concurrency.test.ts`   |
| Contract closure       | `tests/happy_api_contract.test.ts`           | `pnpm --filter @slopus/rig-gym-tests exec vitest run tests/happy_api_contract.test.ts`           |

Platform owns transport, lifecycle, identity, authentication, configuration,
instructions, security, and debugging. Environment owns profile, media,
onboarding, and installation-wide usage. Projects and workspaces own their
respective lifecycle, initialization, ordering, archival, and failure
transitions. Files and Git own confinement, guarded writes, revisions,
snapshots, and watches. Terminals and proxy own terminal lifecycle and
attachment plus both project-root and child-workspace network contexts. Agent
catalogs own the ordered top-level-agent series, archival, read state, drafts,
and Agent Base ancestry restrictions. Transcript and runs own sending,
queueing, steering, abort, compaction, history, presentations, and usage.
Questions and activity own answers, subagents, and background processes. Sync
and concurrency own events, SSE, bootstrap, cursors, versions, mutation echoes,
races, reconnects, gaps, and restart. Contract closure owns the final ledger,
removed legacy routes, and whole-surface reconciliation.

Parallel Luna lanes add tests only. When a black-box reproduction finds a
product defect, the reproduction stays unchanged and the production fix is
made serially outside all parallel lanes, then the affected lane resumes.

**C. Close the surface.** Run every lane independently, then the complete gym
suite. The contract-closure owner reconciles test evidence back into the
ledger. A dedicated `pnpm test:gym:api` command runs the entire API suite. Add
no internal import, test-only endpoint, elevation, sleep, shared fixture, or
legacy behavior to make a gap disappear.

## Criteria for the whole plan

- The new client can drive the entire public API against a real local daemon.
- Every documented route and event family has black-box success coverage, and
  every documented conflict, unavailable state, authorization boundary, size
  limit, and invalid-operation family has deterministic failure coverage.
- Projects and workspaces expose their own ordered top-level-agent series while
  workspace nesting remains purely the file and checkout hierarchy.
- Project registration, workspace creation, file access, Git watching,
  terminals, processes, messages, steering, and both levels of network proxy
  are proven by their real observable effects.
- Snapshot-plus-stream reconciliation is correct across concurrent mutations,
  reconnects, stale versions, cursor gaps, and daemon restart.
- Tests use only isolated `.local/g/<run>/<instance>` state, require no
  elevation or external credentials, wait for observable state rather than
  sleeping, and leave no processes, sockets, workspaces, or files behind.
- Every implementation lane has exclusive file ownership and an independently
  runnable targeted command; the whole suite remains easy to run from the
  repository root.
- The completed coverage ledger has exactly one passing owner for every public
  method and path, response, stable error, event, version transition, mutation
  echo, effect, restart expectation, and removed legacy route, with no
  unresolved contract disagreement.
