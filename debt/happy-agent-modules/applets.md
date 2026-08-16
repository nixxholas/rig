# Module report: applets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/applets/` as the v2 rewrite of
Rig's applet capability (`packages/rig/sources/applets/`, `packages/rig/sources/tools/applets/`),
judged against the root `AGENTS.md` and master plans 00, 13, 14, 16, 20, 21.

## Summary

The applets module is the rewrite's plugin-catalog surface: eight tools over a transactional catalog
and a staged filesystem import. Its transaction and staging design is a clear improvement on v1 —
the catalog commits before anything touches disk, so a failed import leaves nothing behind. The
debts around it are concrete: as `packages/happy-agent` wires the module, its three primary
mutating tools cannot execute at all; two of the eight tools are the same tool under two names; the
icon requirement plan 13 states and v1 enforced has been relaxed; and the image pipeline v1 got
from `sharp` and the `thumbhash` package is now 594 lines of hand-written PNG, resampling, and
container-framing code that this module must maintain itself.

## Changes from the Rig v1 implementation

- **`create_applet` and `import_applet` are the same tool.** `tools/import_applet.ts:11` says so in
  its own comment ("Alias for callers that name applet creation an import"); both take
  `appletToolImportInputSchema`, both carry identical permission predicates, and `create` delegates
  straight to `import` (`AppletModule.ts:376-378`). V1 exposed one creation tool. Master plan 16 is
  explicit that a model's behavior is the tool array it receives; handing it two names for one
  action invites the model to believe the two differ. Open rewrite debt: pick one name and delete
  the alias.
- **The icon became optional — a regression.** V1's `applet_create` requires `iconPath` ("the
  required 512x512 PNG icon", `packages/rig/sources/tools/applets/applet_create.ts:26-28`), matching
  plan 13's "Every plugin must have an icon, and the icon is generated. A plugin without one does
  not register." The rewrite makes it optional (`Applet.ts:174`, `AppletModule.ts:1009-1026`), so an
  applet can be installed with no identity at all. The README compounds this: icons are accepted
  only on initial import, so `update_applet` cannot correct one later.
- **Source-path safety moved from the module to the host, and the host does not supply it.** V1
  calls `assertShareableLocalPath` on both the folder and the icon (`applet_create.ts:44-47`),
  confining imports to the workspace or the generated-media directory. The rewrite delegates to an
  injected `sourcePathPolicy` and fails closed if absent (`AppletModule.ts:296-301`). Fail-closed is
  the right default, but the v1 boundary rule itself has not been carried over into any injected
  policy — see finding 1.
- **The image pipeline was reimplemented instead of taken from libraries.** V1 calls `sharp` and the
  `thumbhash` package (`packages/rig/sources/imports/createIconArtifacts.ts:1-8`) and produces a
  multi-size ICO with a superellipse mask. The rewrite hand-writes `decodePngToRgba` and
  `resizeRgbaLanczos` (`pngImage.ts`, 427 lines), vendors the reference ThumbHash encoder into
  `thumbhash.ts` (167 lines), and wraps the PNG in a single-frame ICO (`appletIcon.ts:92-106`).
  Avoiding a native dependency is a defensible goal, but PNG colour models, resampling, and binary
  container framing are three of the hardest things to get right, and the rewrite now owns all
  three plus a downgraded ICO. This is the module's largest carrying cost.
- **Staging order is a deliberate improvement.** See "What it gets right".

## Findings

1. **Three of the eight tools cannot run as the product wires them.**
   `packages/happy-agent/sources/modules/agent/loadHappyAgent.ts:383` constructs
   `new AppletModule({ rootDirectory: configuration.paths.appletsPath })` — no `sourceReaderFactory`
   and no `sourcePathPolicy`. Both default to functions that throw ("Applet source reader is not
   configured.", `AppletModule.ts:295`; "Applet source path policy is not configured.",
   `AppletModule.ts:300`). Every `create_applet`, `import_applet`, and `update_applet` call
   therefore fails after being offered to the model, permission-reviewed, and possibly elevated to
   Full access. The module's own README describes these as required options; nothing enforces that
   at construction. This is the highest-priority item in the module: the rewrite's applet creation
   path is dead on arrival, and the missing `sourcePathPolicy` is also where v1's path confinement
   was supposed to land.
2. **Review is coupled 1:1 to Full-access elevation on every mutating tool.** `create_applet`,
   `import_applet`, `update_applet`, `remove_applet` and `revert_applet` all set
   `requiresAutoOrFullAccess: true`, `shouldReviewInAutoMode: () => true`,
   `shouldRunInFullAccessInAutoMode: () => true` together (`tools/create_applet.ts:20-22`,
   `tools/import_applet.ts:20-22`, `tools/update_applet.ts:45-47`, `tools/remove_applet.ts:20-22`,
   `tools/revert_applet.ts:29-31`). AGENTS.md: "Define `shouldRunInFullAccessInAutoMode` only for
   reviewed actions that must cross the sandbox; review alone must not imply elevation." For import
   and update the elevation is defensible — they write under `~/Happy/Applets`. For `revert_applet`
   it is not: the module's own README says "Revert changes only catalog state", and the code only
   moves a version pointer inside the agent database (`AppletModule.ts:561-597`). V1's
   `applet_revert` has the same coupling, so this is inherited debt rather than a regression — but
   the rewrite is the opportunity to break it, and the sibling collaboration module shows what
   review-without-elevation looks like.
3. **A migration creates two tables so the next migration can drop them.** `001-applets-catalog`
   creates `happy_agent_module_applet_receipts` and `happy_agent_module_applet_proofs`
   (`AppletModule.ts:257-269`); `002-remove-applet-idempotency` drops both
   (`AppletModule.ts:272-284`). The README explains this as respecting migration immutability, which
   is correct policy in general — but AGENTS.md's early-stage rule says to "advance the database
   generation and reset it explicitly rather than rewriting an existing migration", not to carry a
   create-then-drop pair forward. Every fresh install now creates two tables it immediately
   destroys, and the constants naming them (`AppletDatabase.ts:31-32`) stay exported.
4. **The module validates its own store's pagination arithmetic.** `#assertListPage`
   (`AppletModule.ts:768-810`, called at `418`) checks that the catalog returned no more rows than
   requested, that the cursor progressed, that an offset cursor advanced by exactly the visible item
   count, and that a terminal page carries no cursor — with distinct error messages for each,
   including "Applet catalog changed from an opaque cursor to an offset." The catalog it is checking
   is `AppletDatabase.ts` in the same directory, a module-private SQL view it constructs itself
   (`AppletModule.ts:289`). Nothing else can supply it. This is the trusted-internal-contract
   over-validation pattern, and it is one of several: `#catalogLock` re-checks that the lock
   returned the name it asked for (`AppletModule.ts:903-910`).
5. **An unbounded post-commit promise chain.** `#postCommitChain` (`AppletModule.ts:244`) is
   extended on every mutation (`AppletModule.ts:1132-1133`) and never drained or bounded. AGENTS.md:
   "Do not create unbounded promise chains…". The serialization intent is reasonable; the growth is
   not managed.
6. **Two storage layers for one catalog.** `AppletStore.ts` (321 lines) defines the catalog
   contract, its schemas, and its assertions; `AppletDatabase.ts` (339 lines) implements the same
   contract in SQL and is the only implementation (`AppletDatabase.ts:37`:
   `export type AppletDatabase = AppletCatalog`). The abstraction is never varied, and every value
   crossing it is re-validated on both sides.
7. **Dead public surface.** `formatForModel` (`AppletModule.ts:691-699`) is public and unused —
   every applet tool goes through `formatPageForModel`, `formatAppletForModel`,
   `formatOperationForModel`, `formatAssetForModel` instead. Sibling modules
   (`tasks/TasksModule.ts:462`, `worklets/WorkletsModule.ts:1050`) have live `formatForModel`
   methods, so this looks like a copied shape rather than a used one.
8. **Formatting throws instead of truncating in several places.** `formatForModel`,
   `formatPageForModel`, `formatOperationForModel` and `formatRemovalForModel`
   (`AppletModule.ts:691-741`) raise errors such as "Applet model output would hide an applet
   identity; request a smaller page." when the rendered text exceeds the budget. A successful
   catalog mutation whose result happens to render long becomes a tool error, and the message
   instructs the model to "request a smaller page" for an operation that has no page size.
9. **The README records product limitations as notes rather than decisions.** It documents the
   create-then-drop migration pair, that operation IDs are "history identity only and does not make
   a repeated request a replay", and that icons are accepted only on initial import so
   `update_applet` cannot change one. The last of these is a real, permanent limitation for users
   (an applet's icon can never be corrected) and should be a tracked rewrite item, not prose.
10. **Master-plan naming.** The master plans place ready-made capabilities in
    `@slopus/happy-agent-features` and have not yet been updated to name `happy-agent-modules`; the
    plans need the user's dictation to catch up with the rewrite direction.

## What it gets right

- **The staging order is better than v1's and clearly explained.** The bounded source is read into
  memory inside the catalog transaction, and the filesystem is only touched after that transaction
  commits, by materializing a hidden directory and renaming it into place
  (`AppletModule.ts:320-375`, README "Transactions and events"). A rolled-back import leaves no
  half-written directory. Version allocation is an atomic catalog-row update rather than a heap
  lock, with a comment explaining why (`AppletModule.ts:496-498`).
- Permission descriptions are specific and disclose the boundary being crossed
  (`AppletModule.ts:673-690`), using `quoteVisibleExact` so a path with unusual characters cannot
  misrepresent itself in an approval prompt — exactly what AGENTS.md means by
  `describeAutoPermissionAction`.
- Read tools are correctly classified: `get_applet`, `list_applets`, `read_applet_asset` are
  `durable: true` with `shouldReviewInAutoMode: () => false` and no elevation
  (`tools/get_applet.ts:24-25`, `tools/list_applets.ts:13-14`, `tools/read_applet_asset.ts:18-19`).
- Source copying enforces file-count, total-byte and per-file-byte limits and rejects symlinks and
  special files, and asset reads reject traversal and restrict extensions — the untrusted-input
  boundary is taken seriously throughout (`copyAppletTree.ts`, `readAppletAssetFile.ts`).
- `allowedScopes` and `assertScopeAllowed` (`AppletModule.ts:481-490`) implement plan 14's scope
  rule without importing the slots module, keeping the dependency direction clean.
- The module is covered by a substantial test file (`tests/applets/AppletModule.test.ts`, 898
  lines), which is more than several siblings can say.
