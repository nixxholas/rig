import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import {
    slotContentSchema,
    slotEntrySchema,
    slotNameSchema,
    slotScopeSchema,
} from "../../protocol/SlotProtocol.js";
import { describeSlotCreatePermissionAction } from "./describeSlotPermissionAction.js";
import { requireSlots } from "./requireSlots.js";

export const slotCreateTool = defineTool({
    name: "slot_create",
    label: "Create slot entry",
    description:
        "Plug content into one of the Happy app's fixed UI slots: the status line, above the composer, the workspace/project title, or the sidebar. Content is markdown text or a button with an action. Scope the entry to everywhere, one project, one workspace, or one session, providing exactly the matching id. The description says what the entry is and the purpose says why it exists, so anyone can trace it back to this conversation.",
    arguments: Type.Object(
        {
            slot: slotNameSchema,
            scope: slotScopeSchema,
            projectId: Type.Optional(Type.String()),
            workspaceId: Type.Optional(Type.String()),
            sessionId: Type.Optional(Type.String()),
            content: slotContentSchema,
            description: Type.String({ description: "What the entry is." }),
            purpose: Type.String({ description: "Why the entry exists." }),
        },
        { additionalProperties: false },
    ),
    returnType: slotEntrySchema,
    execute: (args, context) => requireSlots(context).createEntry(args),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Added a ${result.content.type} entry to the ${result.slot} slot.`,
    shouldReviewInAutoMode: () => true,
    describeAutoPermissionAction: describeSlotCreatePermissionAction,
    locks: ["slots"],
});
