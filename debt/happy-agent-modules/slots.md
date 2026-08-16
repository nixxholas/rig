# Module report: slots

Reviewed: 2026-08-15. Scope: `packages/happy-agent-modules/sources/slots/` (README, `SlotsModule.ts`,
`SlotDatabase.ts`, `SlotStore.ts`, `SlotEvent.ts`, `Slot.ts`, `tools/`) compared against Rig's slot
implementation (`packages/rig/sources/tools/slots/`, `slots/SlotEntryStore.ts`, `protocol/SlotProtocol.ts`,
`persistence/slots/`), root `AGENTS.md`, and master plans 00, 14 (slots), 16, 20, 21.

## Summary

A full second implementation of slots — schema, storage, ordering, events, and six tools — living beside
Rig's own. Master plan 14 is explicit that Rig owns slots: the storage is Rig's database, the API is Rig's
HTTP API, and change notification is Rig's global stream. This module instead creates a private database
(`SlotsModule.ts:144`, `this.#store = createSlotDatabase()`), then spends several hundred lines validating
that private store as if it were hostile input, while the tools it exposes are renamed, unreviewed variants
of Rig's.

## How it differs from Rig's equivalents

- **Ownership.** Plan 14 places slot entries in Rig's own persistence with a global-stream change event so
  the UI updates. Entries written here land in the module's tables and never reach that stream, so nothing
  renders them. Two stores now claim the same product concept.
- **Tool names.** Rig uses `slot_create`, `slot_list`, `slot_update`, `slot_remove`. The module uses
  `create_slot`, `list_slots`, `get_slot`, `update_slot`, `reorder_slots`, `remove_slot` — the same
  capabilities under inverted names, so a model that has seen one surface guesses wrong on the other.
- **Permissions.** Rig's `tools/slots/slot_create.ts` is `shouldReviewInAutoMode: () => true` with
  `describeAutoPermissionAction: describeSlotCreatePermissionAction` and `locks: ["slots"]`, while
  `slot_list.ts` is `() => false` with `locks: []` — review is on the mutations, not the reads. Every tool
  in this module declares `shouldReviewInAutoMode: () => false`: `create_slot.ts:67`, `update_slot.ts:36`,
  `remove_slot.ts:16`, `reorder_slots.ts:25`, `get_slot.ts:29`, `list_slots.ts:15`. Slot entries are
  user-facing chrome; Rig reviews writing them and this module does not.
- **Extra and missing surface.** Rig has no `reorder_slots`; this module invents it, and it is the most
  constrained tool in the set (finding 3). Conversely plan 14 step C also calls for a tool to create an
  applet, which the module does not have.

## Findings

1. **The package contradicts the master plans.** Plans 16 and 21 place ready-made agent capabilities in
   `@slopus/happy-agent-features`; no master plan mentions `happy-agent-modules` at all. For slots
   specifically the contradiction is sharper, since plan 14 assigns the whole feature to Rig.
2. **The module distrusts a store it constructs itself.** `SlotsModule` creates the database at line 144 and
   then adversarially re-checks its every answer: `assertSlotStorePage` (`:447`) with the messages "Slots
   database returned a page outside the requested bounds." (`:450`) and "…non-progressing cursor." (`:456`),
   "Slots database created a different entry." (`:250`), "…updated immutable or unrequested entry fields."
   (`:293`), "…changed entry content while reordering." (`:357`), "Slots database removed a different entry."
   (`:387`), backed by the field-by-field comparators `sameCreation`/`sameUpdate`/`sameReorderStableFields`
   (`:915-963`). This is the over-validation of a trusted internal contract that AGENTS.md warns against,
   at roughly a third of the file's length, and the failure mode it produces — an exception mid-turn — is
   worse than the bug it imagines.
3. **Reorder cannot work on a shared catalog.** `#reorder` (`:324-368`) requires the id list to name every
   current entry (`#assertCompleteOrder`, `:616-623`) *and* asserts the acting agent authored every entry
   (`:335`). Any slot entry created by another agent makes reordering permanently impossible — not a
   partial failure, a total one. Ordering is also global rather than per slot and scope
   (`SlotDatabase.ts`), so entries in unrelated slots share one sequence.
4. **Listing fails on other agents' entries.** `listPage` (`:158-173`) authorizes every returned entry
   through `#authorizeEntries`/`#authorizeRead` (`:570-590`); without an explicit `readAuthorization`
   option, a page containing one foreign-authored entry throws instead of filtering. Reading a catalog
   should not be an ownership operation.
5. **Retry loops and character-at-a-time fitting.** The same `listPage` re-runs the whole query with
   `limit-1`, down to 1, to fit the output budget — up to 50 database round trips for one call. And
   `#fitDetailPage` (`:762-783`) shrinks the detail slice one character at a time, re-formatting on each
   iteration (~1024 iterations). Both are correctness-neutral but expensive by construction.
6. **N+1 writes in storage.** `SlotDatabase.reorder` (`:246-265`) issues a `get` plus an `UPDATE` per entry,
   and `remove` (`:267-285`) rewrites `ordering` across all remaining entries globally.
7. **Vestigial schemas.** `SlotStore.ts` declares `slotStoreSchema = Type.Unknown()` with an
   `assertSlotStore` that only checks `typeof value === "object"` — a validation shell that validates
   nothing. `SlotEvent.ts:89-95` goes the other way: `slotListenerValidationView` reflects over prototypes
   purely so a class-backed listener can satisfy a TypeBox `Type.Function` check the module imposed on
   itself.
8. **Dead migration pair.** `SlotDatabase.ts` migration `001-slots` creates
   `happy_agent_slot_receipts` and `happy_agent_slot_mutation_proofs`, and `002-remove-slot-idempotency`
   drops both. The handling is correct — released migrations are immutable, so a follow-up drop is the right
   move — but it is the fossil of an idempotency design that was built and abandoned, and the reader has to
   work that out from the migration log.

## What it gets right

The data model is faithful to plan 14: four slot kinds, the everywhere/project/workspace/session scopes,
text and button content, and an author/description/purpose record on every entry, so a human reading the
catalog can tell who put what there and why. Mutations run inside the module's transaction boundary, the
scope rules are enforced in one place rather than per tool, pagination is cursor-based with an explicit
output budget, and the abandoned idempotency tables were retired by an additive migration rather than by
editing history.
