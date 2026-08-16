# Module report: worklets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/worklets/` compared against
Rig's shipping worklets implementation (`packages/rig/sources/worklets/`,
`packages/rig/sources/tools/worklets/workletTools.ts`, `packages/happy-worklets/`), root
`AGENTS.md`, and master plans 00, 16, 17, 20, 21.

## Summary

This is a second implementation of master plan 17, of the same feature Rig already ships, writing
into the same user-visible folder, with a different `worklet.json` contract, different tool names,
a different on-disk file set, and no permission model at all. Rig's version reviews and elevates
every change to the installed set because a worklet is code that runs outside the workspace
sandbox; this module's nine tools all declare `shouldReviewInAutoMode: () => false`. The installer
itself is careful, well-argued work — the staging, containment, and reconciliation logic is the
best code in the four modules reviewed — but it is aimed at a directory another component already
owns, and its reconciliation deletes what it does not recognize.

## How it differs from Rig's equivalents

- **Same folder, two owners.** `getWorkletsDirectory.ts:13-28` is a byte-for-byte reimplementation
  of `packages/rig/sources/worklets/getWorkletsDirectory.ts`: same `HAPPY_WORKLETS_DIRECTORY`
  variable, same `~/Happy/Worklets` on macOS and `~/happy/worklets` elsewhere, same absolute-path
  check. Both modules therefore install into the same tree while keeping separate catalogs.
- **Incompatible `worklet.json`.** Rig's manifest declares `name`, `description`, and the disk and
  network `permissions` Rig then enforces on the running process
  (`packages/rig/sources/worklets/README.md`, `resolveWorkletPermissions.ts`,
  `describeWorkletPermissions.ts`). This module's manifest is `{ "operations": [...] }` and nothing
  else — `WorkletInstaller.ts:800-803` reads only `operations`, capped at 512 bytes
  (line 38). Two components read the same filename and expect different documents.
- **Incompatible folder contents.** Rig writes `favicon.png`, `favicon.ico`, `worklet.log`, `Data/`,
  and `vN/` into `<root>/<name>/`. This module's `#removeCodeFromBase` accepts only `Data`,
  `favicon.png`, `vN`, and its own staging names, and throws
  `"The worklet folder contains an unexpected entry"` on anything else
  (`WorkletInstaller.ts:454-478`) — *after* it has already deleted the entries it did recognize.
  Running `remove_worklet` against a Rig-installed worklet destroys its icon and versions and then
  fails on `favicon.ico`.
- **Reconciliation deletes unrecognized versions.** `#ensureReconciled` runs before every
  operation and walks the whole install root (`WorkletInstaller.ts:524-556`). For a worklet in this
  module's catalog, any `vN` folder not in *its* version set is removed
  (`#reconcileKnownBase`, lines 506-512); for a worklet with no catalog row, "all code is orphaned
  and is removed" (lines 128-151). Rig's installed worklets are not in this module's catalog.
- **No permission model.** Rig's `worklet_install`, `worklet_update`, `worklet_revert`, and
  `worklet_uninstall` each declare `requiresAutoOrFullAccess: true`,
  `shouldReviewInAutoMode: () => true`, and a `describeAutoPermissionAction` that names the exact
  path, the worklet's declared disk/network permissions, and the sentence
  "copies files outside the workspace sandbox and runs the worklet in the background"
  (`workletTools.ts:20-21,44-48,77-81,115-118,137-141`). The module's `install_worklet`,
  `update_worklet`, `revert_worklet`, `remove_worklet`, and `invoke_worklet_operation` declare
  `shouldReviewInAutoMode: () => false` and none of the other three hooks
  (`tools/install_worklet.ts:20`, `tools/update_worklet.ts:33`, `tools/revert_worklet.ts:30`,
  `tools/remove_worklet.ts:22`, `tools/invoke_worklet_operation.ts:18`).
- **Tool names diverge.** `install_worklet`/`update_worklet`/`revert_worklet`/`remove_worklet`/
  `list_worklets`/`read_worklet_logs`/`get_worklet_status`/`get_worklet` against Rig's
  `worklet_install`/`worklet_update`/`worklet_revert`/`worklet_uninstall`/`worklet_list`/
  `worklet_logs`. Neither set is wrong on its own; two sets for one capability is.

## Findings

1. **Installing and running third-party code is never reviewed.** `install_worklet` copies an
   arbitrary absolute source path into `~/Happy/Worklets` — outside any workspace — and
   `invoke_worklet_operation` calls into that code, both with
   `shouldReviewInAutoMode: () => false`. The module's own README states the boundary plainly:
   "Confining a running worklet's writes at runtime is a separate concern this module does not
   implement" (`README.md:50-52`), and plan 17 states "For now there is no security model for the
   code itself. We trust what we install." Rig resolves that by reviewing the install; this module
   resolves it by reviewing nothing. It is the single most consequential difference between the two
   implementations.
2. **`invoke_worklet_operation` contradicts plan 17.** The plan says "A worklet declares tools,
   MCP-shaped, and those tools become available to agents like any other tool," which Rig
   implements through `WorkletToolRegistry` as an `McpToolProvider`. The module instead exposes one
   generic dispatch tool taking `{ name, operation, arguments }`
   (`Worklet.ts:389-396`, `tools/invoke_worklet_operation.ts`). That is dynamic tool dispatch behind
   a single definition — the machinery plan 16 forbids — and it also means worklet calls bypass the
   `requiresAutoOrFullAccess` review that reaching the same code through MCP would get.
3. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent
   capabilities in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`.
4. **A migration that creates two tables so the next one can drop them.** `WorkletDatabase.ts` /
   `WorkletsModule.ts` follow the same receipts-and-proofs create-then-drop pattern as the other
   modules, and the README describes the follow-up migration as a feature
   (`README.md:74-77`) while also advertising that the design it belonged to is absent
   (`README.md:112-113`). Correct under the immutable-migration rule, still dead weight on every
   fresh install.
5. **Admitted debt shipped as prose.** The README carries three known gaps inline: the TOCTOU race
   on ancestor swapping, argued away over eight lines (`README.md:63-70`); "It does not start a
   process, build code, own a timer, or enforce a runtime process sandbox" (lines 6-7); and the
   runtime write confinement that plan 17 calls "the one boundary we do enforce" being explicitly
   out of scope (lines 50-52). Against plan 17's step A — "Done when a worklet installed from a
   folder runs in the background, writes state that outlives an update, and cannot write anywhere
   else" — the module implements the middle clause only.
6. **The `WorkletRuntime` has no implementation.** Status, logs, and operation invocation are all
   delegated to an injected runtime the module does not supply and Rig does not provide in this
   shape, so `get_worklet_status`, `read_worklet_logs`, and `invoke_worklet_operation` describe
   behavior nothing in the repository can perform.
7. **A placeholder icon is invented when the source has none.** `WorkletInstaller.ts:64-65` writes
   a valid placeholder `favicon.png` if the source folder does not supply one. Rig's
   `worklet_install` requires a 512×512 PNG as a mandatory argument and refuses without it
   (`workletTools.ts:30-33`). Silently manufacturing a user-visible icon is a product decision made
   in an installer.
8. **Two exported names for one tool.** `tools/get_worklet_status.ts:17,36` exports
   `statusWorkletTool` and then `export const getWorkletStatusTool = statusWorkletTool`.
9. **Redundant schema alias.** `workletToolInvocationInputSchema = workletInvocationInputSchema`
   (`Worklet.ts:398`).
10. **Bounds chosen without a stated basis.** `MAX_WORKLET_LIST_PAGE_BYTES = 32 MiB` and
    `MAX_WORKLET_RECORD_BYTES = 16 MiB` (`Worklet.ts:11-13`) for a record that is a name, an owner,
    an integer, and at most 100 version rows of ≤512-character descriptions. A 16 MiB single-record
    ceiling is three orders of magnitude above anything the schema can produce.
11. **Model-facing status values are raw identifiers.** `workletStatusStateSchema` includes
    `"running/awake"` alongside `"running"` and `"awake"` (`Worklet.ts:159-166`) — three states
    where the plan describes two (awake and asleep) — and no tool defines a UI rendering, so
    nothing turns them into the human-readable English AGENTS.md requires. Every Rig worklet tool
    defines `toUI` (`workletTools.ts:58,93-94,122-123,147,165-168,189`).

## What it gets right

- **The installer is genuinely careful.** Every source entry is `lstat`ed; symlinks, special files,
  files over 10 MiB, and trees over 10,000 entries or 100 MiB are refused; each version is copied
  into a hidden staging directory and atomically renamed into place before the catalog mutation, so
  the database never records a version whose files are not fully written; a failed mutation
  compensates the move and can restore a displaced icon (`WorkletInstaller.ts:155-426`,
  `README.md:37-52`). Containment is re-checked immediately before each filesystem operation rather
  than once up front.
- **Crash recovery is real.** Reconciliation removes staging leftovers and version directories with
  no catalog row, repairing an interruption between the rename and the catalog write, and never
  touches `Data` (`WorkletInstaller.ts:484-587`). The `Data`-survives-everything rule — install,
  update, revert, and remove — is implemented exactly as plan 17 describes
  (`#removeCodeFromBase` skips `Data` at line 455).
- **The residual TOCTOU race is reasoned about rather than ignored.** The README explains why Node
  cannot close it without `openat`, and why a process that could exploit it already has the access
  the race would grant (`README.md:63-70`). That is the right way to document a limit, even though
  the module carries several others that are not similarly bounded.
- **Cursor contracts are expressed in the type system.** `workletListPageSchema` and
  `workletLogPageSchema` (`Worklet.ts:242-264,340-387`) use discriminated union branches so that a
  page with a continuation must contain at least one record and a terminal page cannot carry one —
  invariants the other modules enforce with runtime assertions instead.
- **Install, update, and revert are durable and transactional** (`tools/install_worklet.ts:18-19`,
  `tools/update_worklet.ts:31-32`, `tools/revert_worklet.ts:28-29`), using Agent Base's call ID as
  the operation identity, while remove and invoke are honestly marked non-durable with the reason
  stated (`README.md:115-118`) — the plan 21 durability rule applied correctly.
