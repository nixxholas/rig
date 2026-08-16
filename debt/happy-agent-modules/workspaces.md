# Module report: workspaces

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/workspaces/` as the v2 rewrite of
Rig's v1 workspace tools (`packages/rig/sources/tools/workspaces/workspaceTools.ts`,
`transfer_session.ts`), read against root `AGENTS.md` and master plans 00, 03, 16, 20, 21.

## Summary

`WorkspacesModule` rebuilds the workspace surface — `create_workspace`, `list_workspaces`,
`get_workspace`, `transfer_workspace`, `archive_workspace`, `get_workspace_branch_metadata` —
around an opaque host facade, with clean transactional bookkeeping and a durability split that is
correctly reasoned. Two things regress from the v1 baseline. In the two destructive cases v1
reviewed the action and disclosed what it destroys; the rewrite reviews neither and discloses
nothing. And the rewrite drops the one thing master plan 03 calls mandatory — the branch — reducing
a workspace to an opaque `projectRef`/`baseRef` pair. Around that core sits an unusually heavy layer
of self-validation over a store the module constructs itself.

The master plans still name `@slopus/happy-agent-features` and have not been updated for the
`happy-agent-modules` rewrite.

## Changes from the Rig v1 implementation

- **Improvement — transfer distinguishes scheduled from completed.**
  `workspaceTransferResultSchema` (`WorkspaceTransfer.ts:63-81`) is a discriminated union on
  `state`, so the model is told which outcome it got rather than left to infer it. v1's
  `transfer_session` returned a flatter result.
- **Improvement — ownership is modelled explicitly.** `ownerAgentId` is part of the persisted record
  and `#authorize` default-denies cross-agent access unless an injected policy permits the specific
  action, with the reasoning written down (`Workspace.ts:67-70`). v1 had no such boundary.
- **Improvement — archival is the durable decision, cleanup is not.** `archive_workspace` is
  `durable: true, transactional: true` and records the decision in the catalog, leaving worktree and
  folder removal to the host (`tools/archive_workspace.ts:17,20-21`, `README.md:48-50`) — plan 03's
  "Deleting the folder is background cleanup, not the archival decision," implemented directly.
- **Regression — `archive_workspace` lost its review and its disclosure.** v1 declared
  `shouldReviewInAutoMode: () => true` with
  `describeAutoPermissionAction: … "archive workspace X and remove its managed worktree"`
  (`workspaceTools.ts:83-85`). v2 declares `shouldReviewInAutoMode: () => false` and no describer
  (`tools/archive_workspace.ts:22`). Plan 03 calls archiving "an immediate, irreversible logical
  action"; the rewrite makes the irreversible action the one that never surfaces to a reviewer.
- **Regression — session transfer lost its review and its disclosure.** v1's `transfer_session`
  reviewed and spelled out the consequence — "discarding that target workspace's current commit and
  all local working state" (`transfer_session.ts:34-36`). v2's `transfer_workspace` performs the
  same move with `shouldReviewInAutoMode: () => false` and no disclosure
  (`tools/transfer_workspace.ts:19`), while its own README describes the host as owning "snapshot,
  checkout, and filesystem behavior."
- **Regression — the branch is gone, against plan 03.** The plan: "A worktree must always be a
  branch … The branch name is mandatory. A lot of software now depends on it." v1's
  `create_workspace` said so in its argument description — "Rig builds the Git branch and folder
  from it, so write a title rather than a slug or a path" (`workspaceTools.ts:54-57`). v2's
  `workspaceSchema` (`Workspace.ts:71-84`) has no branch field; branch information exists only as
  optional host-reported metadata behind a separate tool (`WorkspaceBranchMetadata.ts:9-20`).
- **Regression — tool names collide with still-live v1 tools under different argument spellings.**
  `create_workspace`, `list_workspaces`, and `archive_workspace` exist in both. v1 uses `base_ref`,
  `project_id`, `workspace_id` (`workspaceTools.ts:48,79,199`); v2 uses `baseRef`, `projectRef`,
  `workspaceId` (`Workspace.ts:102-109`, `tools/archive_workspace.ts:8`). v1's result carries `path`
  and `projectId`; v2's carries neither a path nor any way to reach one.
- **Open debt — new read tools without the plan-03 API story.** `get_workspace` and
  `get_workspace_branch_metadata` (`tools/get_workspace.ts`, `tools/get_branch_metadata.ts`) have no
  v1 counterpart, and each invents its own character-offset detail-paging protocol. Plan 03 wants
  Git deltas available "through the API"; exposing them as model tools instead is a design choice
  the rewrite has not yet reconciled with the plan.
- **Open debt — no `toUI`.** Every v1 workspace tool defines one
  (`workspaceTools.ts:69,88,188,218-221`); no v2 tool does.

## Findings

1. **Two irreversible actions bypass Auto review entirely.** All six tools declare
   `shouldReviewInAutoMode: () => false`, and none declares `requiresAutoOrFullAccess`,
   `shouldRunInFullAccessInAutoMode`, or `describeAutoPermissionAction`
   (`tools/create_workspace.ts:20`, `tools/list_workspaces.ts:19`, `tools/get_workspace.ts:27`,
   `tools/transfer_workspace.ts:19`, `tools/archive_workspace.ts:22`,
   `tools/get_branch_metadata.ts:26`). The README defends this as a rule — "they act only through
   the host store rather than the local sandbox" (`README.md:57-59`) — but archiving destroys a
   worktree and transferring discards a target workspace's working state, and both effects happen
   outside Rig's sandbox precisely because the host performs them. That is the condition AGENTS.md
   attaches `requiresAutoOrFullAccess` to, and the condition v1 reviewed under. Sibling modules in
   this package do declare permission hooks (`sources/mcp/createMcpTool.ts:40`,
   `sources/applets/tools/create_applet.ts:20-23`), so this is not a package-wide convention.
2. **Dead status and dead branch in `create`.** `workspaceStatusSchema` includes `"archiving"`
   (`Workspace.ts:52`), but `assertArchivedWorkspace` requires the authoritative post-archive status
   to be exactly `"archived"` (`WorkspacesModule.ts:1140-1141`), so no module path can produce or
   accept `archiving`. In `create`, `before` is provably `undefined` — lines 218-220 throw
   otherwise — so `changed = before === undefined && !sameJson(before, after)`
   (`WorkspacesModule.ts:238`) is always `true`, the guard at 239-241 can never fire, and the
   `return { result }` branch at line 252 is unreachable.
3. **Over-validation of a locally constructed store.** `#store` is built by the module's own
   `createWorkspaceStore(...)` (`WorkspacesModule.ts:163-164`), and every call is still wrapped in
   `requirePromise`, re-checked with `assertWorkspaceCreateResult` /
   `assertWorkspaceArchiveResult` / `assertWorkspaceTransferResult`, cross-checked against a fresh
   `store.get` with `sameJson`, and cross-checked again for identity and owner
   (lines 222-241, 469, 539-551, 564-571). `WorkspaceStore.ts:200-262` defines eleven such assertion
   functions. This validates nothing the compiler does not already guarantee.
4. **A migration that creates two tables so the next one can drop them.**
   `WorkspaceStore.ts:338-355` creates `happy_agent_module_workspace_operation_receipts` and
   `happy_agent_module_workspace_mutation_proofs`; lines 358-366 drop both. The same abandoned
   idempotency-ledger residue as `userInput`, `workflows`, and `worklets` — a package-wide pattern,
   correct under the immutable-migration rule and still dead on every fresh install.
5. **A host-only transfer shape that no tool exposes.** `workspaceTransferInputSchema` is a union of
   session transfer and project transfer (`WorkspaceTransfer.ts:37-40`), and the README explains
   that the project shape is deliberately hidden from the model (`README.md:89-92`). One method, two
   unrelated operations, one of them unreachable from the tool surface.
6. **An adapter-shape union in a public result schema.**
   `workspaceTransferStoreResultSchema = Union([workspaceTransferResultSchema, workspaceSchema])`
   (`WorkspaceTransfer.ts:88-91`) accepts a bare workspace row as a transfer result "only as an
   adapter result", then normalizes it. A tolerance for one host's shape encoded in the module's own
   type.
7. **Three parallel detail-paging protocols.** `get_workspace` pages with
   `detailOffset`/`detailLimit` over an 8,192-character stream (`WorkspaceDetailPage.ts:10-26`);
   `get_workspace_branch_metadata` pages with the same field names over a 2,048-character stream
   (`WorkspaceBranchMetadataPage.ts:13-32`); `list_workspaces` uses a decimal string `cursor`
   (`WorkspacePage.ts:13-16`). Three cursor conventions for one module, and none matches the
   `cursor`/`nextCursor` integer convention `workflows` and `worklets` use in the same package.
8. **Formatters double as validators.** `formatPageForModel`, `formatDetailPageForModel`, and
   `formatBranchMetadataDetailPageForModel` (`WorkspacesModule.ts:655-747`) re-run `Value.Check`
   over their input and throw on a budget overrun, and the module calls them from the read paths for
   that side effect. Rendering and validation are one function.
9. **Bounds without a basis.** `MAX_WORKSPACE_NAME_LENGTH = 500` (`Workspace.ts:11`) for a value v1
   describes as "a short title naming the work"; `MAX_WORKSPACE_BASE_REF_LENGTH = 1_024` for a Git
   ref.
10. **Model-facing text carries raw identifiers.** `transfer_workspace`'s `toLLM` interpolates a
    workspace ID into a sentence (`tools/transfer_workspace.ts:26-31`), and with no `toUI` anywhere
    in the module, status values such as `initializing` and `archiving` reach any display
    unconverted.

## What it gets right

- **Archival is treated as the durable decision, not the cleanup.** `archive_workspace` is
  `durable: true, transactional: true` and records the decision in the catalog, with worktree and
  folder cleanup left to the host as a separate asynchronous concern
  (`tools/archive_workspace.ts:17,20-21`, `README.md:48-50`). That matches plan 03 exactly:
  "Deleting the folder is background cleanup, not the archival decision."
- **Transfer distinguishes scheduled from completed.** `workspaceTransferResultSchema`
  (`WorkspaceTransfer.ts:63-81`) is a discriminated union on `state`, and the model is told which it
  got rather than being left to infer it — the explicit-states-and-terminal-transitions rule in
  AGENTS.md's change discipline, applied correctly.
- **The catalog-mutation vs host-crossing durability split is correct and stated.**
  `create_workspace` and `archive_workspace` are durable and transactional because they only touch
  the catalog; `transfer_workspace` is non-durable because the host effect cannot be committed
  atomically with the tool result (`README.md:10-12,60-62`).
- **Ownership is enforced on every path.** `#authorize` allows self-access and otherwise refuses
  unless an injected policy permits the specific action (`list`, `get`, `branch_metadata`,
  `transfer`), and `ownerAgentId` is deliberately part of the persisted record with the reasoning
  written down: "the module cannot enforce exact ownership if a host can omit it"
  (`Workspace.ts:67-70`).
- **Events follow plan 21's two-callback shape**, with the transactional listener inside the
  mutation transaction, the post-commit listener after commit via `afterCommit`, both receiving the
  same deeply frozen object (`WorkspaceEvent.ts:69-90`, `WorkspacesModule.ts:783-788,860-867`), and
  a listener failure reported rather than allowed to fail a committed mutation.
