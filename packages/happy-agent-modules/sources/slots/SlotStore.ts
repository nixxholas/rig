import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import {
    slotAgentIdSchema,
    slotContentSchema,
    slotDescriptionSchema,
    slotEntrySchema,
    slotIdSchema,
    slotNameSchema,
    slotPurposeSchema,
    slotScopeReferenceIdSchema,
    slotScopeReferenceSchema,
    type SlotEntry,
    type SlotScopeReference,
} from "./Slot.js";
import { slotEventSchema, type SlotEvent } from "./SlotEvent.js";
import { slotListSchema, slotPageSchema, type SlotList, type SlotPage } from "./SlotPage.js";

const opaqueContextSchema = Type.Unsafe<Context>(Type.Object({}, { additionalProperties: true }));

const slotStoreCreateBaseProperties = {
    id: slotIdSchema,
    authorAgentId: slotAgentIdSchema,
    slot: slotNameSchema,
    content: slotContentSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
} as const;

const slotStoreCreateInputSchema = Type.Union([
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("everywhere"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("project"),
            projectId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("workspace"),
            workspaceId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...slotStoreCreateBaseProperties,
            scope: Type.Literal("session"),
            sessionId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

export const slotScopeResolverSchema = Type.Function(
    [opaqueContextSchema, slotAgentIdSchema, slotScopeReferenceSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export type SlotScopeResolver = Static<typeof slotScopeResolverSchema>;

export const slotReadOperationSchema = Type.Union([Type.Literal("get"), Type.Literal("list")]);

export const slotReadAuthorizationSchema = Type.Function(
    [opaqueContextSchema, slotAgentIdSchema, slotAgentIdSchema, slotReadOperationSchema],
    Type.Union([Type.Boolean(), Type.Promise(Type.Boolean())]),
);
export type SlotReadOperation = Static<typeof slotReadOperationSchema>;
export type SlotReadAuthorization = Static<typeof slotReadAuthorizationSchema>;

export const slotPublisherSchema = Type.Function(
    [opaqueContextSchema, slotEventSchema],
    Type.Union([Type.Void(), Type.Promise(Type.Void())]),
);
export type SlotPublisher = Static<typeof slotPublisherSchema>;

export const slotStoreSchema = Type.Unknown();
export type SlotStore = import("./SlotDatabase.js").SlotDatabase;
export const slotStoreCreateInputContractSchema = slotStoreCreateInputSchema;
export type SlotStoreCreateInput = Static<typeof slotStoreCreateInputSchema>;

export function assertSlotStore(value: unknown): asserts value is SlotStore {
    if (value === null || typeof value !== "object") {
        throw new Error("Slots module received an invalid database.");
    }
}

export function assertSlotStoreEntry(value: unknown): asserts value is SlotEntry {
    if (!Value.Check(slotEntrySchema, value)) {
        throw new Error("Slot store returned an invalid slot entry.");
    }
}

export function assertSlotStorePage(value: unknown): asserts value is SlotPage {
    if (!Value.Check(slotPageSchema, value)) {
        throw new Error("Slot store returned an invalid bounded slot page.");
    }
}

export function assertSlotStoreList(value: unknown): asserts value is SlotList {
    if (!Value.Check(slotListSchema, value)) {
        throw new Error("Slot store returned an invalid bounded slot list.");
    }
}

export type { SlotEvent, SlotScopeReference };
