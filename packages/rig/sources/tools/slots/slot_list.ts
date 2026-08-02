import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { slotEntrySchema, slotNameSchema, type SlotEntry } from "../../protocol/SlotProtocol.js";
import { requireSlots } from "./requireSlots.js";

export const slotListTool = defineTool({
    name: "slot_list",
    label: "List slot entries",
    description:
        "List the entries plugged into the Happy app's UI slots. Optionally filter by slot, and by scope context: providing a project, workspace, or session id returns the everywhere entries plus the ones scoped to those targets.",
    arguments: Type.Object(
        {
            slot: Type.Optional(slotNameSchema),
            projectId: Type.Optional(Type.String()),
            workspaceId: Type.Optional(Type.String()),
            sessionId: Type.Optional(Type.String()),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        { entries: Type.Array(slotEntrySchema) },
        { additionalProperties: false },
    ),
    execute: (args, context): { entries: SlotEntry[] } => ({
        entries: [...requireSlots(context).listEntries(args)],
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.entries.length === 0
            ? "No slot entries exist."
            : `Found ${String(result.entries.length)} slot ${result.entries.length === 1 ? "entry" : "entries"}.`,
    shouldReviewInAutoMode: () => false,
    locks: [],
});
