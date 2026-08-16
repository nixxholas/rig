# Module report: workspaces

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/workspaces/` compared against
Rig's own workspace tools (`packages/rig/sources/tools/workspaces/workspaceTools.ts`,
`transfer_session.ts`), root `AGENTS.md`, and master plans 00, 03, 16, 20, 21.

## Summary

`WorkspacesModule` reimplements six workspace tools — `create_workspace`, `list_workspaces`,
`get_workspace`, `transfer_workspace`, `archive_workspace`, `get_workspace_branch_metadata` —
around an opaque host facade. Three of its tool names are Rig's, with different argument spellings
and, in the two destructive cases, the opposite Auto-mode behavior: Rig reviews archiving and
session transfer and discloses what they destroy; this module reviews neither and discloses
nothing. It also drops the one thing master plan 03 says is mandatory — the branch — reducing a
workspace to an opaque `projectRef`/`baseRef` pair. What remains is careful transactional
bookkeeping wrapped in an unusually heavy layer of self-validation.

## How it differs from Rig's equivalents

- **`archive_workspace`: reviewed in Rig, unreviewed here.** Rig declares
  `shouldReviewInAutoMode: () => true` with
  `describeAutoPermissionAction: … "archive workspace X and remove its managed worktree"`
  (`workspaceTools.ts:83-85`). The module declares `shouldReviewInAutoMode: () => false` and no
  describer (`tools/archive_workspace.ts:22`). Plan 03 calls archiving "an immediate, irreversible
  logical action"; the module makes the irreversible action the one that never surfaces to a
  reviewer.
- **Session transfer: reviewed in Rig, unreviewed here.** Rig's `transfer_session` reviews and
  spells out the consequence — "discarding that target workspace's current commit and all local
  working state" (`transfer_session.ts:34-36`). The module's `transfer_workspace` performs the same
  move with `shouldReviewInAutoMode: () => false` and no disclosure
  (`tools/transfer_workspace.ts:19`), while its own README describes the host as owning "snapshot,
  checkout, and filesystem behavior."
- **Colliding names, diverging arguments.** `create_workspace`, `list_workspaces`, and
  `archive_workspace` exist in both. Rig uses `base_ref`, `project_id`, `workspace_id`
  (`workspaceTools.ts:48,79,199`); the module uses `baseRef`, `projectRef`, `workspaceId`
  (`Workspace.ts:102-109`, `tools/archive_workspace.ts:8`). Rig's result carries `path` and
  `projectId`; the module's carries neither path nor any way to reach one.
- **The branch is gone.** Plan 03: "A worktree must always be a branch … The branch name is
  mandatory. A lot of software now depends on it." Rig's `create_workspace` says so in its argument
  description — "Rig builds the Git branch and folder from it, so write a title rather than a slug
  or a path" (`workspaceTools.ts:54-57`). The module's `workspaceSchema`
  (`Workspace.ts:71-84`) has no branch field; branch information exists only as optional
  host-reported metadata read through a separate tool (`WorkspaceBranchMetadata.ts:9-20`).
- **Reads Rig does not expose.** `get_workspace` and `get_workspace_branch_metadata`
  (`tools/get_workspace.ts`, `tools/get_branch_metadata.ts`) are new tools, each with its own
  character-offset detail-paging protocol. Rig exposes Git deltas through its API and protocol per
  plan 03 ("All of this must be available through the API"), not as a model tool.

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
   attaches `requiresAutoOrFullAccess` to, and the condition Rig's own two tools review under.
2. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent
   capabilities in `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules`.
3. **Dead status and dead branch in `create`.** `workspaceStatusSchema` includes `"archiving"`
   (`Workspace.ts:52`), but `assertArchivedWorkspace` requires the authoritative post-archive status
   to be exactly `"archived"` (`WorkspacesModule.ts:1140-1141`), so no module path can produce or
   accept `archiving`. In `create`, `before` is provably `undefined` — line 218-220 throws
   otherwise — so `changed = before === undefined && !sameJson(before, after)`
   (`WorkspacesModule.ts:238`) is always `true`, the guard at 239-241 can never fire, and the
   `return { result }` branch at line 252 is unreachable.
4. **Over-validation of a locally constructed store.** `#store` is built by the module's own
   `createWorkspaceStore(...)` (`WorkspacesModule.ts:163-164`), and every call is still wrapped in
   `requirePromise`, re-checked with `assertWorkspaceCreateResult` /
   `assertWorkspaceArchiveResult` / `assertWorkspaceTransferResult`, cross-checked against a fresh
   `store.get` with `sameJson`, and cross-checked again for identity and owner
   (lines 222-241, 469, 539-551, 564-571). `WorkspaceStore.ts:200-262` defines eleven such
   assertion functions. This validates nothing the compiler does not already guarantee.
5. **A migration that creates two tables so the next one can drop them.**
   `WorkspaceStore.ts:338-355` creates `happy_agent_module_workspace_operation_receipts` and
   `happy_agent_module_workspace_mutation_proofs`; lines 358-366 drop both. Same abandoned
   idempotency-ledger residue as `userInput`, `workflows`, and `worklets` — a package-wide pattern,
   correct under the immutable-migration rule and still dead on every fresh install.
6. **A host-only transfer shape that no tool exposes.** `workspaceTransferInputSchema` is a union of
   session transfer and project transfer (`WorkspaceTransfer.ts:37-40`), and the README explains
   that the project shape is deliberately hidden from the model (`README.md:89-92`). One method,
   two unrelated operations, one of them unreachable from the tool surface.
7. **An adapter-shape union in a public result schema.**
   `workspaceTransferStoreResultSchema = Union([workspaceTransferResultSchema, workspaceSchema])`
   (`WorkspaceTransfer.ts:88-91`) accepts a bare workspace row as a transfer result "only as an
   adapter result", then normalizes it. A tolerance for one host's shape encoded in the module's
   own type.
8. **Three parallel detail-paging protocols.** `get_workspace` pages with
   `detailOffset`/`detailLimit` over an 8,192-character stream
   (`WorkspaceDetailPage.ts:10-26`); `get_workspace_branch_metadata` pages with the same field
   names over a 2,048-character stream (`WorkspaceBranchMetadataPage.ts:13-32`); `list_workspaces`
   uses a decimal string `cursor` (`WorkspacePage.ts:13-16`). Three cursor conventions for one
   module, and none matches the `cursor`/`nextCursor` integer convention `workflows` and `worklets`
   use in the same package.
9. **Formatters double as validators.** `formatPageForModel`, `formatDetailPageForModel`, and
   `formatBranchMetadataDetailPageForModel` (`WorkspacesModule.ts:655-747`) re-run `Value.Check`
   over their input and throw on a budget overrun, and the module calls them from the read paths
   for that side effect. Rendering and validation are one function.
10. **Bounds without a basis.** `MAX_WORKSPACE_NAME_LENGTH = 500` (`Workspace.ts:11`) for a value
    Rig describes as "a short title naming the work"; `MAX_WORKSPACE_BASE_REF_LENGTH = 1_024` for a
    Git ref.
11. **Model-facing text carries raw identifiers and no UI rendering.**
    `transfer_workspace`'s `toLLM` interpolates a workspace ID into a sentence
    (`tools/transfer_workspace.ts:26-31`), and no tool in the module defines a UI rendering, so
    status values such as `initializing` and `archiving` reach any display unconverted. Every Rig
    workspace tool defines `toUI` (`workspaceTools.ts:69,88,188,218-221`).

## What it gets right

- **Archival is treated as the durable decision, not the cleanup.** `archive_workspace` is
  `durable: true, transactional: true` and records the decision in the catalog, with worktree and
  folder cleanup left to the host as a separate asynchronous concern
  (`tools/archive_workspace.ts:17,20-21`, `README.md:48-50`). That matches plan 03 exactly:
  "Deleting the folder is background cleanup, not the archival decision."
- **Transfer distinguishes scheduled from completed.** `workspaceTransferResultSchema`
  (`WorkspaceTransfer.ts:63-81`) is a discriminated union on `state`, and the model is told which
  it got rather than being left to infer it — the explicit-states-and-terminal-transitions rule in
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
