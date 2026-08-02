import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { slotEntrySchema } from "../../protocol/SlotProtocol.js";
import { requireSlots } from "./requireSlots.js";

export const slotRemoveTool = defineTool({
    name: "slot_remove",
    label: "Remove slot entry",
    description: "Remove a slot entry from the Happy app by its id.",
    arguments: Type.Object(
        { id: Type.String({ description: "The slot entry to remove." }) },
        { additionalProperties: false },
    ),
    returnType: slotEntrySchema,
    execute: ({ id }, context) => requireSlots(context).removeEntry(id),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Removed the ${result.content.type} entry from the ${result.slot} slot.`,
    shouldReviewInAutoMode: () => true,
    locks: ["slots"],
});
