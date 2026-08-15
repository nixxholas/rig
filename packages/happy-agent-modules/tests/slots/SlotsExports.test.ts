import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";
import * as SlotExports from "../../sources/slots/Slot.js";
import * as SlotStoreExports from "../../sources/slots/SlotStore.js";

import {
    MAX_SLOT_ENTRIES,
    slotCreateInputSchema,
    slotOrderingSchema,
    slotReorderInputSchema,
    slotScopeReferenceSchema,
    slotUpdateInputSchema,
    type SlotCreateInput,
    type SlotOrdering,
    type SlotReorderInput,
    type SlotScopeReference,
    type SlotUpdateInput,
} from "../../sources/slots/Slot.js";
import {
    slotCursorSchema,
    slotPageQueryEverywhereSchema,
    slotPageQueryNoScopeSchema,
    slotPageQueryProjectSchema,
    slotPageQuerySchema,
    slotPageQuerySessionSchema,
    slotPageQueryWorkspaceSchema,
    type SlotCursor,
    type SlotPageQueryEverywhere,
    type SlotPageQueryNoScope,
    type SlotPageQueryProject,
    type SlotPageQuerySession,
    type SlotPageQueryWorkspace,
} from "../../sources/slots/SlotPage.js";
import {
    slotDetailCursorSchema,
    slotDetailPageSchema,
    slotDetailQuerySchema,
    type SlotDetailCursor,
    type SlotDetailQuery,
} from "../../sources/slots/SlotDetailPage.js";

describe("public slot exports", () => {
    it("exports domain, ordering, and cursor contracts without replay contracts", () => {
        const create: SlotCreateInput = {
            slot: "status-line",
            scope: "everywhere",
            content: { type: "text", markdown: "Ready" },
            description: "Status",
            purpose: "Show readiness",
        };
        const update: SlotUpdateInput = { purpose: "Show current readiness" };
        const reorder: SlotReorderInput = ["entry-1"];
        const ordering: SlotOrdering = 0;
        const cursor: SlotCursor = 1;
        const detailCursor: SlotDetailCursor = 1;
        const detailQuery: SlotDetailQuery = { detailOffset: detailCursor, detailLimit: 1 };
        const reference: SlotScopeReference = { scope: "everywhere" };
        const noScope: SlotPageQueryNoScope = {};
        const everywhere: SlotPageQueryEverywhere = { scope: "everywhere" };
        const project: SlotPageQueryProject = { scope: "project", projectId: "project-1" };
        const session: SlotPageQuerySession = { scope: "session", sessionId: "session-1" };
        const workspace: SlotPageQueryWorkspace = {
            scope: "workspace",
            workspaceId: "workspace-1",
        };

        expect(Value.Check(slotCreateInputSchema, create)).toBe(true);
        expect(Value.Check(slotUpdateInputSchema, update)).toBe(true);
        expect(Value.Check(slotReorderInputSchema, reorder)).toBe(true);
        expect(Value.Check(slotOrderingSchema, ordering)).toBe(true);
        expect(Value.Check(slotCursorSchema, cursor)).toBe(true);
        expect(Value.Check(slotCursorSchema, 0)).toBe(true);
        expect(Value.Check(slotCursorSchema, MAX_SLOT_ENTRIES)).toBe(true);
        expect(Value.Check(slotCursorSchema, -1)).toBe(false);
        expect(Value.Check(slotCursorSchema, MAX_SLOT_ENTRIES + 1)).toBe(false);
        expect(Value.Check(slotCursorSchema, "1")).toBe(false);
        expect(Value.Check(slotDetailCursorSchema, detailCursor)).toBe(true);
        expect(Value.Check(slotDetailQuerySchema, detailQuery)).toBe(true);
        expect(
            Value.Check(slotDetailPageSchema, {
                entry: null,
            }),
        ).toBe(true);
        expect("slotMutationOptionsSchema" in SlotExports).toBe(false);
        expect("slotOperationStateSchema" in SlotExports).toBe(false);
        expect("slotMutationProofSchema" in SlotStoreExports).toBe(false);
        expect("slotOperationReceiptSchema" in SlotStoreExports).toBe(false);
        expect(Value.Check(slotScopeReferenceSchema, reference)).toBe(true);
        expect(Value.Check(slotPageQuerySchema, noScope)).toBe(true);
        expect(Value.Check(slotPageQueryNoScopeSchema, noScope)).toBe(true);
        expect(Value.Check(slotPageQueryEverywhereSchema, everywhere)).toBe(true);
        expect(Value.Check(slotPageQueryProjectSchema, project)).toBe(true);
        expect(Value.Check(slotPageQuerySessionSchema, session)).toBe(true);
        expect(Value.Check(slotPageQueryWorkspaceSchema, workspace)).toBe(true);
    });
});
