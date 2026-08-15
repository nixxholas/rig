import { defineAgentTool } from "@slopus/happy-agent-base";
import { Type } from "@sinclair/typebox";

import { slotIdSchema, slotRemoveResultSchema } from "../Slot.js";
import type { SlotsModule } from "../SlotsModule.js";

/** Remove one slot entry by stable ID. */
export function removeSlotTool(slots: SlotsModule, agentId: string) {
    return defineAgentTool({
        name: "remove_slot",
        description: "Remove a persistent Happy UI slot entry by its stable ID.",
        parameters: Type.Object({ id: slotIdSchema }, { additionalProperties: false }),
        returnType: slotRemoveResultSchema,
        durable: true,
        transactional: true,
        shouldReviewInAutoMode: () => false,
        execute: async (ctx, input: { id: string }) => ({
            removed: await slots.remove(ctx, agentId, input.id),
        }),
        toLLM: ({ removed }) => [
            {
                type: "text",
                text: removed ? "Slot entry removed." : "Slot entry was already absent.",
            },
        ],
    });
}
