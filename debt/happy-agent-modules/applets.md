# Module report: applets

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/applets/` compared against Rig's
applet implementation (`packages/rig/sources/applets/`, `packages/rig/sources/tools/applets/`),
root `AGENTS.md`, and master plans 00, 13, 14, 16, 20, 21.

## Summary

4,265 lines re-implementing a capability Rig already ships in 781 lines of `applets/` plus four
tool files. The module adds a hand-written PNG decoder, a hand-written Lanczos resampler and a
vendored copy of the `thumbhash` package (594 lines of image code) to avoid a native dependency; it
exposes eight tools where Rig exposes four, two of which are the same tool under two names; and as
wired in `packages/happy-agent`, four of those eight tools cannot execute at all. The transaction
and filesystem staging design is genuinely good and better than Rig's, which makes the surrounding
excess more conspicuous.

## How it differs from Rig's equivalents

- **Eight tools against four.** Rig has `applet_create`, `applet_list`, `applet_update`,
  `applet_revert` (`packages/rig/sources/tools/applets/`). The module has `create_applet`,
  `import_applet`, `list_applets`, `get_applet`, `update_applet`, `revert_applet`, `remove_applet`,
  `read_applet_asset` (`AppletModule.ts:757-766`). Names are also inverted — `applet_create` versus
  `create_applet` — so a model moved between the two surfaces sees an entirely different vocabulary
  for identical operations.
- **`create_applet` and `import_applet` are the same tool.** `tools/import_applet.ts:11` says so in
  its own comment ("Alias for callers that name applet creation an import"); both take
  `appletToolImportInputSchema`, both carry identical permission predicates, and
  `create` delegates straight to `import` (`AppletModule.ts:376-378`). Master plan 16 is explicit
  that a model's behavior is the tool array it receives; handing it two names for one action is the
  opposite of a fixed, deliberate array, and it invites the model to believe the two differ.
- **The icon is optional here and required in Rig.** Rig's `applet_create` requires `iconPath`
  ("the required 512x512 PNG icon", `packages/rig/sources/tools/applets/applet_create.ts:26-28`),
  matching plan 13's "Every plugin must have an icon, and the icon is generated. A plugin without
  one does not register." The module makes it optional (`Applet.ts:174`,
  `AppletModule.ts:1009-1026`), so an applet can be installed with no identity at all.
- **Source-path safety moves from Rig to the host.** Rig calls `assertShareableLocalPath` on both
  the folder and the icon (`applet_create.ts:44-47`), confining imports to the workspace or the
  generated-media directory. The module has no such rule of its own: it delegates to an injected
  `sourcePathPolicy` and fails closed if absent (`AppletModule.ts:296-301`). Fail-closed is right,
  but the actual boundary is now the host's problem, and see finding 1.
- **Image handling.** Rig calls `sharp` and the `thumbhash` package
  (`packages/rig/sources/imports/createIconArtifacts.ts:1-8`) and produces a proper multi-size ICO
  with a superellipse mask. The module hand-writes `decodePngToRgba` and `resizeRgbaLanczos`
  (`pngImage.ts`, 427 lines), copies the reference ThumbHash encoder into `thumbhash.ts` (167
  lines), and wraps the PNG in a single-frame ICO (`appletIcon.ts:92-106`). Three of the hardest
  things to get right — PNG colour models, resampling, and binary container framing — are now
  maintained twice in one repository, with the second copy carrying no dependency on the first.

## Findings

1. **Four of the eight tools cannot run as the product wires them.**
   `packages/happy-agent/sources/modules/agent/loadHappyAgent.ts:383` constructs
   `new AppletModule({ rootDirectory: configuration.paths.appletsPath })` — no `sourceReaderFactory`
   and no `sourcePathPolicy`. Both default to functions that throw
   ("Applet source reader is not configured.", `AppletModule.ts:295`; "Applet source path policy is
   not configured.", `AppletModule.ts:300`). Every `create_applet`, `import_applet`, and
   `update_applet` call therefore fails after being offered to the model, permission-reviewed, and
   possibly elevated to Full access. The module's own README describes these as required options;
   nothing enforces that at construction.
2. **Review is coupled 1:1 to Full-access elevation on every mutating tool.**
   `create_applet`, `import_applet`, `update_applet`, `remove_applet` and `revert_applet` all set
   `requiresAutoOrFullAccess: true`, `shouldReviewInAutoMode: () => true`,
   `shouldRunInFullAccessInAutoMode: () => true` together (`tools/create_applet.ts:20-22`,
   `tools/import_applet.ts:20-22`, `tools/update_applet.ts:45-47`, `tools/remove_applet.ts:20-22`,
   `tools/revert_applet.ts:29-31`). AGENTS.md: "Define `shouldRunInFullAccessInAutoMode` only for
   reviewed actions that must cross the sandbox; review alone must not imply elevation." For import
   and update the elevation is defensible — they write under `~/Happy/Applets`. For `revert_applet`
   it is not: the module's own README says "Revert changes only catalog state", and the code only
   moves a version pointer inside the agent database (`AppletModule.ts:561-597`). Rig's
   `applet_revert` has the same coupling, so this is inherited rather than invented — but it is
   inherited into a package that had the chance to fix it.
3. **A migration creates two tables so the next migration can drop them.**
   `001-applets-catalog` creates `happy_agent_module_applet_receipts` and
   `happy_agent_module_applet_proofs` (`AppletModule.ts:257-269`); `002-remove-applet-idempotency`
   drops both (`AppletModule.ts:272-284`). The README explains this as respecting migration
   immutability, which is correct policy — but the module is only consumed by
   `packages/happy-agent`, and AGENTS.md's early-stage rule says to "advance the database
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
9. **The README carries design debt in prose.** It documents the create-then-drop migration pair,
   that operation IDs are "history identity only and does not make a repeated request a replay",
   and that icons are accepted only on initial import so `update_applet` cannot change one — a real
   product limitation (an applet's icon can never be corrected) recorded as a note rather than as a
   decision anyone signed off on.

## What it gets right

- **The staging order is better than Rig's and clearly explained.** The bounded source is read into
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
