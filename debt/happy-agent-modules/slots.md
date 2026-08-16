# Module report: slots

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/slots/` (README, `SlotsModule.ts`,
`SlotDatabase.ts`, `SlotStore.ts`, `SlotEvent.ts`, `Slot.ts`, `tools/`) reviewed as the v2 rewrite of the
v1 slot implementation (`packages/rig/sources/tools/slots/`, `slots/SlotEntryStore.ts`,
`protocol/SlotProtocol.ts`, `persistence/slots/`), against root `AGENTS.md` and master plans 00, 14
(slots), 16, 20, 21.

## Summary

A complete rewrite of slots — schema, storage, ordering, events, and six tools. The data model is faithful
to master plan 14 and the transaction boundary is cleaner than v1's. Three things are outstanding: entries
are not yet visible to users because the rewrite has not reconnected them to the change stream plan 14
requires, every mutation lost the Auto review v1 applied, and a large fraction of the file is spent
defensively re-validating the module's own store.

## Changes from the Rig v1 implementation

- **Entries are no longer visible (open rewrite debt, currently a functional gap).** Master plan 14 requires
  slot entries to reach a global-stream change event so the UI updates. v2 constructs its own store
  (`SlotsModule.ts:144`, `this.#store = createSlotDatabase()`) and nothing yet republishes changes to that
  stream, so entries written through these tools do not reach any surface a user sees. Owning the storage
  inside the module is a legitimate rewrite choice; the missing change-event bridge is the unfinished half.
- **Mutations lost Auto review (regression).** v1's `tools/slots/slot_create.ts` is
  `shouldReviewInAutoMode: () => true` with `describeAutoPermissionAction: describeSlotCreatePermissionAction`
  and `locks: ["slots"]`, while `slot_list.ts` is `() => false` with `locks: []` — review sits on the
  mutations, not the reads. In v2 every tool declares `shouldReviewInAutoMode: () => false`:
  `create_slot.ts:67`, `update_slot.ts:36`, `remove_slot.ts:16`, `reorder_slots.ts:25`, `get_slot.ts:29`,
  `list_slots.ts:15`. Slot entries are user-facing chrome, and writing them is now unreviewed and
  undisclosed.
- **Tool names inverted (churn).** v1 used `slot_create`/`slot_list`/`slot_update`/`slot_remove`; v2 uses
  `create_slot`/`list_slots`/`get_slot`/`update_slot`/`reorder_slots`/`remove_slot`. Verb-first is a
  defensible house style, but it is a rename with no functional gain, and models carrying v1 priors will
  guess the old names.
- **`reorder_slots` and `get_slot` are new (improvements).** v1 had neither; giving agents control of catalog
  order and a single-entry read is a real extension of the surface. As shipped, `reorder_slots` is the most
  constrained tool in the set — see finding 3.
- **Applet creation not carried over (open rewrite debt).** Plan 14 step C also calls for a tool to create
  an applet; the module does not have one.

## Findings

1. **The master plans have not been updated for the rewrite.** Plans 16 and 21 still place ready-made agent
   capabilities in `@slopus/happy-agent-features` and do not mention `happy-agent-modules`. Plan 14 is a
   substantive constraint the rewrite still has to satisfy, which is finding 2.
2. **Slot changes never reach the UI.** The private store at `SlotsModule.ts:144` has no bridge to the
   change event plan 14 specifies, so the feature is write-only from the user's point of view. This is the
   highest-value item to close in this module.
3. **Reorder cannot work on a shared catalog.** `#reorder` (`:324-368`) requires the id list to name every
   current entry (`#assertCompleteOrder`, `:616-623`) *and* asserts the acting agent authored every entry
   (`:335`). One entry created by another agent makes reordering permanently impossible — not a partial
   failure, a total one. Ordering is also global rather than per slot and scope (`SlotDatabase.ts`), so
   entries in unrelated slots share one sequence.
4. **Listing throws on other agents' entries.** `listPage` (`:158-173`) authorizes every returned entry
   through `#authorizeEntries`/`#authorizeRead` (`:570-590`); without an explicit `readAuthorization`
   option, a page containing one foreign-authored entry throws instead of filtering it out. Reading a shared
   catalog should not be an ownership operation.
5. **The module distrusts a store it constructs itself.** Having created the database at line 144, it
   adversarially re-checks its every answer: `assertSlotStorePage` (`:447`) with "Slots database returned a
   page outside the requested bounds." (`:450`) and "…non-progressing cursor." (`:456`), "Slots database
   created a different entry." (`:250`), "…updated immutable or unrequested entry fields." (`:293`),
   "…changed entry content while reordering." (`:357`), "Slots database removed a different entry."
   (`:387`), backed by the field-by-field comparators `sameCreation`/`sameUpdate`/`sameReorderStableFields`
   (`:915-963`). This is the over-validation of a trusted internal contract AGENTS.md warns against, at
   roughly a third of the file's length, and its failure mode — an exception mid-turn — is worse than the
   bug it imagines.
6. **Retry loops and character-at-a-time fitting.** `listPage` re-runs the whole query with `limit-1`, down
   to 1, to fit the output budget — up to 50 database round trips for one call. `#fitDetailPage`
   (`:762-783`) shrinks the detail slice one character at a time, re-formatting on each iteration (~1024
   iterations). Both are correctness-neutral but expensive by construction.
7. **N+1 writes in storage.** `SlotDatabase.reorder` (`:246-265`) issues a `get` plus an `UPDATE` per entry,
   and `remove` (`:267-285`) rewrites `ordering` across all remaining entries globally.
8. **Vestigial schemas.** `SlotStore.ts` declares `slotStoreSchema = Type.Unknown()` with an
   `assertSlotStore` that only checks `typeof value === "object"` — a validation shell that validates
   nothing. `SlotEvent.ts:89-95` goes the other way: `slotListenerValidationView` reflects over prototypes
   purely so a class-backed listener can satisfy a TypeBox `Type.Function` check the module imposed on
   itself.
9. **Abandoned idempotency machinery in the migration log.** `001-slots` creates
   `happy_agent_slot_receipts` and `happy_agent_slot_mutation_proofs`; `002-remove-slot-idempotency` drops
   both. The handling is correct — released migrations are immutable, so an additive drop is the right move
   — but a design was built and retired inside the rewrite, and the reader has to reconstruct that from the
   migration log.

## What it gets right

The data model is faithful to plan 14 and clearer than v1's: four slot kinds, the
everywhere/project/workspace/session scopes, text and button content, and an author/description/purpose
record on every entry, so a human reading the catalog can tell who put what there and why. Scope rules are
enforced in one place rather than per tool, mutations run inside the module's transaction boundary,
pagination is cursor-based against an explicit output budget, `reorder_slots` and `get_slot` extend the
surface past v1, and the abandoned idempotency tables were retired by an additive migration rather than by
editing history.
