import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { slotContentSchema, slotEntrySchema, slotNameSchema } from "../../protocol/SlotProtocol.js";
import { requireSlots } from "./requireSlots.js";

export const slotUpdateTool = defineTool({
    name: "slot_update",
    label: "Update slot entry",
    description:
        "Update an existing slot entry's slot, content, description, or purpose. The entry's scope is fixed at creation; remove and recreate an entry that should move.",
    arguments: Type.Object(
        {
            id: Type.String({ description: "The slot entry to update." }),
            slot: Type.Optional(slotNameSchema),
            content: Type.Optional(slotContentSchema),
            description: Type.Optional(Type.String()),
            purpose: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    returnType: slotEntrySchema,
    execute: ({ id, ...request }, context) => requireSlots(context).updateEntry(id, request),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Updated the ${result.content.type} entry in the ${result.slot} slot.`,
    shouldReviewInAutoMode: () => true,
    locks: ["slots"],
});
