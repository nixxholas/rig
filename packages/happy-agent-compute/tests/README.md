# Compute test coverage

The ordinary suite is deterministic and uses fakes where a unit boundary is intentional. The
`tests/live` lane is the evidence for claims that only an operating-system sandbox, Docker daemon,
or real backend can prove.

## Running live tests

Live tests are opt-in:

```sh
HAPPY_AGENT_COMPUTE_LIVE_TEST=1 pnpm --filter @slopus/happy-agent-compute \
  exec vitest run tests/live
```

The Docker image defaults to `rig-gym:local`. Override it with
`HAPPY_AGENT_COMPUTE_DOCKER_IMAGE`. The image must contain Bubblewrap, `socat`, Node, and the
normal Docker sandbox prerequisites.

Run the host lane outside an already restricted process. macOS Seatbelt and Linux Bubblewrap
cannot necessarily nest inside an agent or CI runner sandbox. Run the Docker lane where the Docker
socket is available.

When the opt-in is absent, live cases are reported as skipped. When it is present, a missing OS
sandbox, Docker daemon, or Docker image throws from setup and fails the suite. A live prerequisite
must never turn into a passing assertion.

A package script would make the intended lane discoverable. The exact line to add to `scripts` is:

```json
"test:live": "HAPPY_AGENT_COMPUTE_LIVE_TEST=1 vitest run tests/live"
```

## Rig parity audit

Status meanings:

- **Present**: compute exercises the same observable contract at an equal or stronger boundary.
- **Weaker**: compute has coverage, but replaces a real boundary with a fake or omits material Rig
  cases.
- **Missing**: no compute test establishes the Rig contract.
- **Vacuous**: a nominal compute test can finish without executing its assertions.
- **Out of scope**: the test belongs to Rig's agent loop, reviewer, UI, provider, or session layer;
  it is listed so absence is explicit rather than accidental.
- **Obsolete**: the Rig test targets the deleted ambient permission-revision model. The compute
  equivalent is the new immutable per-operation contract.

### Agent context, filesystem, sandbox, and network

| Rig test                                                    | Compute equivalent                                                                        | Status                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ManagedNetworkPolicy.test.ts`                              | `tests/network/ManagedNetworkPolicy.test.ts`                                              | Present                                                                                                                                                                                                      |
| `assertCanWritePath.test.ts`                                | `tests/sandbox/assertCanWritePath.test.ts`, host/just-bash/Docker permission tests        | Present; compute adds caller denials and grants                                                                                                                                                              |
| `createJustBashBashContext.test.ts`                         | `tests/justBash/createJustBashCompute.test.ts`                                            | Weaker; exit reporting is present, but oldest-session eviction and completed-session retention have no equivalent assertion                                                                                  |
| `createJustBashFileSystemContext.test.ts`                   | `tests/justBash/createJustBashCompute.test.ts`                                            | Present                                                                                                                                                                                                      |
| `createLinuxBubblewrapCommand.test.ts`                      | `tests/sandbox/createLinuxBubblewrapCommand.test.ts`                                      | Present                                                                                                                                                                                                      |
| `createMacOsSeatbeltCommand.test.ts`                        | `tests/sandbox/createMacOsSeatbeltCommand.test.ts`, `tests/live/hostSandbox.live.test.ts` | Weaker; generated policy and core live boundary are covered, but Rig's live Unix-socket and protected-config cases were not ported                                                                           |
| `createNodeAgentContext.test.ts` filesystem and shell cases | host compute, filesystem, shell, and host live tests                                      | Weaker; core execution is present, while Git broker, Git identity, selected-secret injection, and provider-control-channel cases remain above this package                                                   |
| `createNodeBashContext.test.ts`                             | `tests/host/createHostShell.test.ts`                                                      | Weaker; timeout, deltas, stdin, process-tree stop, exit notification, eviction, and network mapping are present; cleanup-failure, orphan-child, peek, retention-cap, and several lifecycle races are missing |
| `createNodeFileSystemContext.test.ts`                       | `tests/host/createHostCompute.test.ts`, host live tests                                   | Present for paging, bounded reads, `noFollow`, per-operation permissions, and host read/write boundaries                                                                                                     |
| `createProtectedPathMonitor.test.ts`                        | none                                                                                      | Missing                                                                                                                                                                                                      |
| `createSandboxConfigDirectoryCache.test.ts`                 | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `createSandboxFilesystemConfig.test.ts`                     | same-named sandbox test                                                                   | Present; compute adds operation-specific grants and denials                                                                                                                                                  |
| `createSandboxedCommand.test.ts`                            | same-named sandbox test                                                                   | Present for command construction and prerequisites; real enforcement is in the live host lane                                                                                                                |
| `createSensitiveReadPaths.test.ts`                          | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `createShellEnvironment.test.ts`                            | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `createToolEnvironment.test.ts`                             | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `findGitWritablePaths.test.ts`                              | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `formatManagedNetworkDenial.test.ts`                        | same-named network test                                                                   | Present                                                                                                                                                                                                      |
| `isPathInsideWorkspace.test.ts`                             | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `justBashArchiveCodecs.test.ts`                             | none                                                                                      | Missing                                                                                                                                                                                                      |
| `loadProjectManagedNetworkPolicy.test.ts`                   | Docker loader test and `toManagedNetworkPolicy.test.ts`                                   | Weaker; no host test proves that root policy is re-read on every call                                                                                                                                        |
| `prepareProjectConfigPlaceholder.test.ts`                   | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `resolveFileSystemPath.test.ts`                             | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `runCleanupSteps.test.ts`                                   | same-named sandbox test                                                                   | Present                                                                                                                                                                                                      |
| `startLinuxManagedNetworkBridge.test.ts`                    | same-named network test                                                                   | Weaker; authentication is present, but partial-start cleanup when the SOCKS bridge fails is missing                                                                                                          |
| `startManagedNetworkProxy.test.ts`                          | same-named network test                                                                   | Present for the core policy, DNS, tunnel, interception, timeout, and cleanup contracts; a few Rig plugin-forwarding variants differ                                                                          |
| `subagentSelectionDescriptions.test.ts`                     | none                                                                                      | Out of scope                                                                                                                                                                                                 |

### Docker execution

| Rig test                                          | Compute equivalent                                                   | Status                                                                                                                                            |
| ------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DockerEnvironment.test.ts`                       | `tests/docker/DockerEnvironment.test.ts`, Docker disposal live cases | Present; compute adds missing-container errors and real managed/attached disposal                                                                 |
| `assertDockerReadPath.test.ts`                    | same-named Docker test                                               | Present; compute adds denied reads                                                                                                                |
| `assertDockerWritePath.test.ts`                   | same-named Docker test                                               | Present; compute adds read-only, grants, denials, and denial precedence                                                                           |
| `createDockerBashContext.test.ts`                 | `tests/docker/createDockerShell.test.ts`, Docker timeout live case   | Weaker; most session mechanics are ported, but Git broker, selected secrets, and permission-revision races are not applicable or not ported       |
| `createDockerFileSystemContext.test.ts`           | `tests/docker/createDockerFileSystem.test.ts`                        | Present at the fake-daemon boundary                                                                                                               |
| `createDockerFileSystemContext.docker.test.ts`    | `tests/live/dockerBackend.live.test.ts`                              | Present and broader: a real daemon is used for containment, `noFollow`, sessions, network, and disposal; the live `noFollow` race currently fails |
| `createDockerSandboxCommand.test.ts`              | same-named Docker test                                               | Present; compute adds independent egress/listener and path grant/deny construction                                                                |
| `formatDockerTouchTimestamp.test.ts`              | same-named Docker test                                               | Present                                                                                                                                           |
| `loadDockerProjectManagedNetworkPolicy.test.ts`   | same-named Docker test                                               | Present                                                                                                                                           |
| `parseDockerPathStat.test.ts`                     | same-named Docker test                                               | Present                                                                                                                                           |
| `prepareDockerNetworkBridgeContainerRoot.test.ts` | same-named Docker test                                               | Present                                                                                                                                           |
| `prepareDockerNetworkBridgeHostRoot.test.ts`      | same-named Docker test                                               | Present                                                                                                                                           |
| `prepareDockerSandbox.test.ts`                    | same-named Docker test                                               | Present; compute adds a human-readable dependency failure                                                                                         |
| `resolveDockerBindMountPath.test.ts`              | same-named Docker test                                               | Present                                                                                                                                           |
| `resolveDockerExecutionConfig.test.ts`            | same-named Docker test                                               | Present                                                                                                                                           |
| `resolveDockerPath.test.ts`                       | same-named Docker test                                               | Present                                                                                                                                           |
| `runDockerExec.test.ts`                           | same-named Docker test                                               | Present                                                                                                                                           |
| `validateDockerExecutionConfig.test.ts`           | same-named Docker test                                               | Present; compute adds union and absolute-path validation                                                                                          |

All pre-existing compute Docker tests use hand-written Dockerode fakes. They prove request
construction, parsing, lifecycle coordination, and fail-closed decisions, but they do not prove
Linux mount, user, PID, or network namespaces. Only `tests/live/dockerBackend.live.test.ts` makes
those kernel claims.

### Existing compute-only coverage defects

| Compute test                             | Live replacement                        | Status                                                                                                                          |
| ---------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `tests/host/hostSandboxBoundary.test.ts` | `tests/live/hostSandbox.live.test.ts`   | Vacuous when its nested-sandbox probe fails: both cases return before asserting. It must not be cited as host boundary evidence |
| Existing `tests/docker/*.test.ts`        | `tests/live/dockerBackend.live.test.ts` | Weaker before this work: every Dockerode interaction was fake and no daemon or kernel boundary ran                              |

### Processes

| Rig test                       | Compute equivalent                            | Status                                                                                                 |
| ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `BoundedOutputBuffer.test.ts`  | `tests/processes/BoundedOutputBuffer.test.ts` | Weaker; compute covers head/tail, offsets, and drain, but not Rig's exact partial-UTF-8 boundary cases |
| `NativeProcessManager.test.ts` | same-named process test                       | Present                                                                                                |
| `waitForProcessExit.test.ts`   | same-named process test                       | Present                                                                                                |

### Permission subsystem

The package owns the execution boundary after a permission decision. It does not own Rig's
automatic reviewer, transcript construction, tool policy, terminal disclosure, or permission menu.

| Rig test                                                                   | Compute equivalent                                      | Status                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `createPermissionContext.test.ts`, `assertPermissionRevision.ts` consumers | operation-scoped permission tests on all three backends | Obsolete; mutable revisions were deleted and replaced by immutable values passed to each operation |
| `isProtectedPath.test.ts`                                                  | sandbox and backend grant/deny tests                    | Present behaviorally; no direct same-function unit test                                            |
| `isPermissionReduction.test.ts`                                            | none                                                    | Out of scope; stopping privileged processes after a UI/session downgrade is owned above compute    |
| `parsePermissionMode.test.ts`                                              | TypeBox `computePermissionModeSchema` consumers         | Weaker; runtime schema exists but has no direct schema test                                        |
| `AutoPermissionDenialCircuitBreaker.test.ts`                               | none                                                    | Out of scope                                                                                       |
| `autoPermission.live.test.ts`                                              | none                                                    | Out of scope                                                                                       |
| `createAutoPermissionTranscript.test.ts`                                   | none                                                    | Out of scope                                                                                       |
| `createPermissionReviewSideAgent.test.ts`                                  | none                                                    | Out of scope                                                                                       |
| `parseAutoPermissionReview.test.ts`                                        | none                                                    | Out of scope                                                                                       |
| `quoteVisibleExact.test.ts`                                                | none                                                    | Out of scope                                                                                       |
| `reviewAutoPermission.test.ts`                                             | none                                                    | Out of scope                                                                                       |
| `shouldAllowAutoPermissionReview.test.ts`                                  | none                                                    | Out of scope                                                                                       |
| `shouldReviewPatchInAutoMode.test.ts`                                      | none                                                    | Out of scope                                                                                       |
| `summarizeEscalatedShellAction.test.ts`                                    | none                                                    | Out of scope                                                                                       |
| `toolAutoPermissionPolicies.test.ts`                                       | none                                                    | Out of scope                                                                                       |

### Relevant gym coverage

Gym proves the assembled Rig product through a real PTY. Compute tests cannot replace its agent,
session, and terminal assertions, but the backend contracts should have a lower-level equivalent.

| Gym test                                                            | Compute equivalent                                          | Status                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `background_child_survives_the_command_that_started_it.test.ts`     | host shell process ownership tests                          | Weaker; no compute live orphan-child case                                                                           |
| `background_shell_output_continues_after_retention_cap.test.ts`     | host/Docker delta and cap tests                             | Present at backend boundary                                                                                         |
| `aborting_active_session_stops_background_processes.test.ts`        | compute disposal and kill tests                             | Weaker; abort/session ownership is above compute                                                                    |
| `aborting_idle_session_stops_background_processes.test.ts`          | compute disposal tests                                      | Weaker; archive/session ownership is above compute                                                                  |
| `reducing_permissions_stops_existing_full_access_processes.test.ts` | none                                                        | Out of scope under per-operation compute permissions; the owning session must decide which existing process to stop |
| `docker_session_routes_files_and_commands_to_container.test.ts`     | Docker filesystem/shell tests and live lane                 | Present at backend boundary                                                                                         |
| `docker_shell_respects_permission_mode.test.ts`                     | Docker containment live case                                | Present                                                                                                             |
| `docker_managed_network_reaches_allowed_http_service.test.ts`       | Docker managed-network live case                            | Present as a test, currently failing because allowed traffic times out                                              |
| `managed_network_request_runs_through_linux_proxy_bridge.test.ts`   | network bridge unit tests and Docker live case              | Weaker until the Docker live allowed path passes                                                                    |
| `sandbox_policy_files_cannot_be_poisoned_by_model_commands.test.ts` | placeholder, protected-path, and sandbox-command tests      | Weaker; no compute live concurrent policy-poisoning case                                                            |
| `workspace_write_uses_codex_linux_sandbox.test.ts`                  | Linux command construction and host/Docker live containment | Present at backend boundary                                                                                         |
| `workspace_write_custom_shell_cannot_bypass_sandbox.test.ts`        | host/Docker custom-shell validation and live containment    | Weaker; no hostile custom-shell live case                                                                           |
| `workspace_write_cannot_install_hidden_git_hooks.test.ts`           | Git protected-path unit tests                               | Weaker; no compute live Git-hook attempt                                                                            |
| `restricted_shell_wrapper_does_not_run_host_profiles.test.ts`       | shell environment unit tests                                | Missing as a live compute scenario                                                                                  |
| `permissions_menu_enforces_read_only_then_full_access.test.ts`      | per-operation read-only/full-access tests                   | Present at backend boundary; menu behavior is out of scope                                                          |
| Auto-review and permission-disclosure gym files                     | none                                                        | Out of scope; they test reviewer authorization, tool policy, and TUI disclosure                                     |

## Live cases and what they prove

### Host

- A real restricted process cannot write outside the workspace, and can write inside it.
- A real read-only process cannot write the workspace.
- `deniedWritePaths` is enforced inside the workspace.
- `allowedWritePaths` opens one real root outside the workspace.
- A write denial beats both the workspace grant and an explicit grant.
- `deniedReadPaths` masks real content, including when the path is also granted.
- Withheld egress blocks real `curl`.
- Withheld local binding blocks a real Node listener even in `full_access`.
- Granted unbounded macOS egress is asserted and currently fails with DNS resolution blocked.

The fixture deliberately lives beside the test rather than in the system temporary directory.
Seatbelt intentionally makes the system temporary directory writable, so a sibling under
`tmpdir()` cannot prove the workspace boundary.

### Docker

- A managed container is really started.
- The container user is first shown able to write `/home/rig` in Full access; a restricted command
  is then shown unable to write it while still writing `/workspace`.
- A live final-component swap races regular files against a symlink while `noFollow` reads through
  Docker's archive API. Any returned bytes must be the regular file, never the target.
- Allowed and denied host policies traverse the real command-scoped proxy and authenticated Unix
  bridge. The allowed path currently times out.
- A timed-out session stays running, observes a release file, and completes afterwards.
- Disposal removes a managed container.
- Disposal leaves an explicitly attached container running.

### Just-bash

- Direct filesystem calls and actual just-bash shell execution share the granular permission
  boundary.
- Read and write denials beat grants.
- An outside write grant applies to only the operation that carries it; the next operation does not
  retain it.

The supervisor's own outgoing proxy is no longer exercised from here. It needs nothing from this
package: the supervisor forks its own egress process and enforces the command's host list itself,
so its end-to-end coverage lives in
`packages/happy-agent-supervisor/native/supervisor/tests/outgoing_proxy.rs`.

## Known unproven or failing claims

1. Docker `noFollow` is not currently atomic. The live swap returned `"secr"` from
   `/home/rig/secret.txt` through `/workspace/race/candidate`.
2. Docker managed-network allowed egress is not currently working in the live package lane. A
   Node fetch through the authenticated bridge reaches its 15-second abort without a response.
3. On macOS, `workspace_write` with unbounded `egress: true` cannot currently resolve
   `example.com` inside Seatbelt (`curl` exit 6), while an independent host curl succeeds.
4. The detailed live Unix-socket, concurrent project-policy, protected Git-hook, hostile custom
   shell, and restricted-profile contracts proven by Rig/gym do not yet have package-level live
   equivalents.
5. Old ambient permission-revision races are intentionally not portable. Equivalent callers must
   be tested for immutable operation snapshots and for higher-layer process shutdown on a later
   permission reduction.
6. The Linux side of the outgoing proxy is proven on arm64 only. The native suite runs green on a
   real arm64 kernel in a container, which covers the namespace isolation, the loopback front-ends
   and the seccomp ordering. The amd64 lane still cannot be run under emulation, because QEMU user
   emulation does not implement `prctl(PR_SET_SECCOMP)`, so the supervisor fails closed there
   before any front-end is reached. That lane needs a real x86_64 kernel in CI.
7. The host proxy has only been driven against a macOS supervisor end to end. The frame protocol is
   architecture independent and is exercised from both sides, but no run has paired the TypeScript
   proxy with a Linux supervisor in one process tree.
