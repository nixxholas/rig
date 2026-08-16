import { Type, type Static } from "@sinclair/typebox";
import { defineAgentTool } from "@slopus/happy-agent-base";

import { slotPageQuerySchema, slotPageSchema } from "../SlotPage.js";
import type { SlotsModule } from "../SlotsModule.js";

/**
 * Providers require an object at the root of a tool's parameters, so the query variants stay a
 * closed union and travel as one argument.
 */
const listSlotsToolParametersSchema = Type.Object(
    { input: slotPageQuerySchema },
    { additionalProperties: false },
);

type ListSlotsToolParameters = Static<typeof listSlotsToolParametersSchema>;

/** Read one bounded page of slot entries. */
export function listSlotsTool(slots: SlotsModule, agentId: string) {
    return defineAgentTool({
        name: "list_slots",
        description:
            "List a bounded page of persistent Happy UI slot entries. Use nextCursor to continue reading a large catalog.",
        parameters: listSlotsToolParametersSchema,
        returnType: slotPageSchema,
        durable: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, { input }: ListSlotsToolParameters) =>
            await slots.listPage(ctx, agentId, input),
        toLLM: (page) => [
            {
                type: "text",
                text: slots.formatPageForModel(page),
            },
        ],
    });
}
