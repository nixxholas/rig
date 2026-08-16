# Module report: worklets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/worklets/` as the v2 rewrite of
Rig's v1 worklets implementation (`packages/rig/sources/worklets/`,
`packages/rig/sources/tools/worklets/workletTools.ts`, `packages/happy-worklets/`), read against
root `AGENTS.md` and master plans 00, 16, 17, 20, 21.

## Summary

The installer is the best code in the four modules reviewed: staging, containment re-checks,
atomic rename before catalog mutation, compensation on failure, and a `Data` folder that survives
install, update, revert, and remove. Two things undercut it. First, the rewrite targets
`~/Happy/Worklets` — the same tree v1 has already been populating — but is incompatible with what
v1 wrote there: a different `worklet.json` document, a different file set, and reconciliation that
deletes version folders it does not recognize. Second, v1 reviewed and elevated every change to
the installed set because a worklet is code that runs outside the workspace sandbox; all nine v2
tools declare `shouldReviewInAutoMode: () => false`. Sibling modules in this same package do
declare permission hooks (`sources/mcp/createMcpTool.ts:40`,
`sources/applets/tools/create_applet.ts:20-23`), so this is not a package convention.

The master plans still name `@slopus/happy-agent-features` and have not been updated for the
`happy-agent-modules` rewrite.

## Changes from the Rig v1 implementation

- **Improvement — containment and crash recovery are now first-class.** v1 copied into the install
  root without a staging/commit/compensate protocol. v2 stages each version in a hidden directory,
  renames it atomically into place before the catalog write, compensates the move if the mutation
  fails, and reconciles leftovers on every subsequent operation
  (`WorkletInstaller.ts:155-426,484-587`). Containment is re-verified immediately before each
  filesystem operation rather than once up front.
- **Improvement — cursor contracts are expressed in the type system.** `workletListPageSchema` and
  `workletLogPageSchema` (`Worklet.ts:242-264,340-387`) use discriminated union branches so a page
  with a continuation must carry at least one record and a terminal page cannot.
- **Regression — review and elevation dropped on every mutating tool.** v1's `worklet_install`,
  `worklet_update`, `worklet_revert`, and `worklet_uninstall` each declared
  `requiresAutoOrFullAccess: true`, `shouldReviewInAutoMode: () => true`,
  `shouldRunInFullAccessInAutoMode: () => true`, and a `describeAutoPermissionAction` naming the
  exact path, the worklet's declared disk/network permissions, and the sentence "copies files
  outside the workspace sandbox and runs the worklet in the background"
  (`workletTools.ts:20-21,44-48,77-81,115-118,137-141`). v2's `install_worklet`, `update_worklet`,
  `revert_worklet`, `remove_worklet`, and `invoke_worklet_operation` declare
  `shouldReviewInAutoMode: () => false` and none of the other three hooks
  (`tools/install_worklet.ts:20`, `tools/update_worklet.ts:33`, `tools/revert_worklet.ts:30`,
  `tools/remove_worklet.ts:22`, `tools/invoke_worklet_operation.ts:18`). This is a protection lost,
  not a difference of taste: the boundary v1 disclosed still exists.
- **Regression — manifest format changed under an existing on-disk format.** v1's `worklet.json`
  declares `name`, `description`, and the disk and network `permissions` v1 then enforces on the
  running process (`packages/rig/sources/worklets/README.md`, `resolveWorkletPermissions.ts`,
  `describeWorkletPermissions.ts`). v2's manifest is `{ "operations": [...] }` and nothing else —
  `WorkletInstaller.ts:800-803` reads only `operations`, capped at 512 bytes (line 38). A v1-written
  manifest carries no `operations`, and the permission declaration v1 enforced has no successor.
- **Regression — folder contents changed, and the mismatch fails destructively.** v1 writes
  `favicon.png`, `favicon.ico`, `worklet.log`, `Data/`, and `vN/` into `<root>/<name>/`. v2's
  `#removeCodeFromBase` accepts only `Data`, `favicon.png`, `vN`, and its own staging names, and
  throws `"The worklet folder contains an unexpected entry"` on anything else
  (`WorkletInstaller.ts:454-478`) — *after* deleting the entries it did recognize. Running
  `remove_worklet` against a v1-installed worklet destroys its icon and versions and then fails on
  `favicon.ico`, leaving the folder in neither state.
- **Regression — reconciliation deletes v1's version folders.** `#ensureReconciled` runs before
  every operation and walks the whole install root (`WorkletInstaller.ts:524-556`). For a worklet
  present in the v2 catalog, any `vN` folder not in *its* version set is removed
  (`#reconcileKnownBase`, lines 506-512); for a worklet with no catalog row, "all code is orphaned
  and is removed" (lines 128-151). v1-installed worklets have no v2 catalog row. The rewrite needs
  either a takeover path or a distinct root; it currently has neither.
- **Regression — tool names changed while v1's are still live.**
  `install_worklet`/`update_worklet`/`revert_worklet`/`remove_worklet`/`list_worklets`/
  `read_worklet_logs` against v1's `worklet_install`/`worklet_update`/`worklet_revert`/
  `worklet_uninstall`/`worklet_list`/`worklet_logs`. Either naming is defensible; both surfaced at
  once to the same model is not.
- **Open debt — the runtime the rewrite depends on does not exist yet.** Status, logs, and
  operation invocation are delegated to an injected `WorkletRuntime` the module does not supply and
  v1 does not provide in this shape, so `get_worklet_status`, `read_worklet_logs`, and
  `invoke_worklet_operation` describe behavior nothing in the repository can currently perform.
- **Open debt — no `toUI`.** Every v1 worklet tool defines one
  (`workletTools.ts:58,93-94,122-123,147,165-168,189`); no v2 tool does.

## Findings

1. **Installing and running third-party code is never reviewed.** `install_worklet` copies an
   arbitrary absolute source path into `~/Happy/Worklets` — outside any workspace — and
   `invoke_worklet_operation` calls into that code, both with
   `shouldReviewInAutoMode: () => false`. The README states the boundary plainly: "Confining a
   running worklet's writes at runtime is a separate concern this module does not implement"
   (`README.md:50-52`), and plan 17 states "For now there is no security model for the code itself.
   We trust what we install." v1 resolved that by reviewing and elevating the install; v2 resolves
   it by reviewing nothing. This is the most consequential thing the rewrite has to restore.
2. **`invoke_worklet_operation` contradicts plan 17.** The plan says "A worklet declares tools,
   MCP-shaped, and those tools become available to agents like any other tool," which v1 implements
   through `WorkletToolRegistry` as an `McpToolProvider`. v2 instead exposes one generic dispatch
   tool taking `{ name, operation, arguments }` (`Worklet.ts:389-396`,
   `tools/invoke_worklet_operation.ts`). That is dynamic tool dispatch behind a single definition —
   the machinery plan 16 forbids — and it also means worklet calls bypass the
   `requiresAutoOrFullAccess` review that reaching the same code through MCP would get.
3. **A migration that creates two tables so the next one can drop them.** `WorkletDatabase.ts` /
   `WorkletsModule.ts` follow the same receipts-and-proofs create-then-drop pattern as the other
   three modules, and the README describes the follow-up migration as a feature
   (`README.md:74-77`) while also advertising that the design it belonged to is absent
   (`README.md:112-113`). Correct under the immutable-migration rule, still dead weight on every
   fresh install of the rewrite.
4. **Admitted debt shipped as prose.** The README carries three known gaps inline: the TOCTOU race
   on ancestor swapping, argued away over eight lines (`README.md:63-70`); "It does not start a
   process, build code, own a timer, or enforce a runtime process sandbox" (lines 6-7); and the
   runtime write confinement plan 17 calls "the one boundary we do enforce" being explicitly out of
   scope (lines 50-52). Against plan 17's step A — "Done when a worklet installed from a folder runs
   in the background, writes state that outlives an update, and cannot write anywhere else" — the
   rewrite implements the middle clause only.
5. **A placeholder icon is invented when the source has none.** `WorkletInstaller.ts:64-65` writes a
   valid placeholder `favicon.png` if the source folder does not supply one. v1's `worklet_install`
   required a 512×512 PNG as a mandatory argument and refused without it
   (`workletTools.ts:30-33`). Silently manufacturing a user-visible icon is a product decision made
   in an installer.
6. **Two exported names for one tool.** `tools/get_worklet_status.ts:17,36` exports
   `statusWorkletTool` and then `export const getWorkletStatusTool = statusWorkletTool`.
7. **Redundant schema alias.** `workletToolInvocationInputSchema = workletInvocationInputSchema`
   (`Worklet.ts:398`).
8. **Bounds chosen without a stated basis.** `MAX_WORKLET_LIST_PAGE_BYTES = 32 MiB` and
   `MAX_WORKLET_RECORD_BYTES = 16 MiB` (`Worklet.ts:11-13`) for a record that is a name, an owner,
   an integer, and at most 100 version rows of ≤512-character descriptions. A 16 MiB single-record
   ceiling is three orders of magnitude above anything the schema can produce.
9. **Model-facing status values are raw identifiers.** `workletStatusStateSchema` includes
   `"running/awake"` alongside `"running"` and `"awake"` (`Worklet.ts:159-166`) — three states where
   the plan describes two (awake and asleep) — and no tool defines a UI rendering, so nothing turns
   them into the human-readable English AGENTS.md requires.

## What it gets right

- **The installer is genuinely careful.** Every source entry is `lstat`ed; symlinks, special files,
  files over 10 MiB, and trees over 10,000 entries or 100 MiB are refused; each version is copied
  into a hidden staging directory and atomically renamed into place before the catalog mutation, so
  the database never records a version whose files are not fully written; a failed mutation
  compensates the move and can restore a displaced icon (`WorkletInstaller.ts:155-426`,
  `README.md:37-52`).
- **Crash recovery is real.** Reconciliation removes staging leftovers and version directories with
  no catalog row, repairing an interruption between the rename and the catalog write, and never
  touches `Data` (`WorkletInstaller.ts:484-587`). The `Data`-survives-everything rule — install,
  update, revert, and remove — is implemented exactly as plan 17 describes (`#removeCodeFromBase`
  skips `Data` at line 455). This is a genuine advance over v1's handling.
- **The residual TOCTOU race is reasoned about rather than ignored.** The README explains why Node
  cannot close it without `openat`, and why a process that could exploit it already has the access
  the race would grant (`README.md:63-70`). That is the right way to document a limit.
- **Cursor contracts are expressed in the type system** (`Worklet.ts:242-264,340-387`), enforcing in
  types what the sibling modules enforce with runtime assertions.
- **Install, update, and revert are durable and transactional** (`tools/install_worklet.ts:18-19`,
  `tools/update_worklet.ts:31-32`, `tools/revert_worklet.ts:28-29`), using Agent Base's call ID as
  the operation identity, while remove and invoke are honestly marked non-durable with the reason
  stated (`README.md:115-118`) — the plan 21 durability rule applied correctly.
