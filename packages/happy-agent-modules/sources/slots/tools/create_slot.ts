import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import {
    slotContentSchema,
    slotDescriptionSchema,
    slotEntryResultSchema,
    slotNameSchema,
    slotPurposeSchema,
    slotScopeReferenceIdSchema,
} from "../Slot.js";
import type { SlotsModule } from "../SlotsModule.js";

const createSlotToolBaseProperties = {
    slot: slotNameSchema,
    content: slotContentSchema,
    description: slotDescriptionSchema,
    purpose: slotPurposeSchema,
} as const;

const createSlotToolInputSchema = Type.Union([
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("everywhere"),
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("project"),
            projectId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("workspace"),
            workspaceId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
    Type.Object(
        {
            ...createSlotToolBaseProperties,
            scope: Type.Literal("session"),
            sessionId: slotScopeReferenceIdSchema,
        },
        { additionalProperties: false },
    ),
]);

/**
 * Providers require an object at the root of a tool's parameters, so the scope variants stay a
 * closed union and travel as one argument.
 */
const createSlotToolParametersSchema = Type.Object(
    { input: createSlotToolInputSchema },
    { additionalProperties: false },
);

type CreateSlotToolParameters = Static<typeof createSlotToolParametersSchema>;

/** Create a persistent slot entry using the stable tool-call ID. */
export function createSlotTool(slots: SlotsModule, agentId: string) {
    return defineAgentTool({
        name: "create_slot",
        description:
            "Create persistent content in one of Happy's fixed UI slots. Use bounded markdown or a button action, provide the exact scope target when needed, and explain both what the entry is and why it exists.",
        parameters: createSlotToolParametersSchema,
        returnType: slotEntryResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: CreateSlotToolParameters, call) => ({
            entry: await slots.create(ctx, agentId, { ...input, id: call.id }),
        }),
        toLLM: ({ entry }) => [
            {
                type: "text",
                text: slots.formatOperationForModel("Slot entry created.", entry),
            },
        ],
    });
}
