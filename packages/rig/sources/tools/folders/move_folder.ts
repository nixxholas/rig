import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { folderSchema } from "../../protocol/FolderProtocol.js";
import { requireFolders } from "./requireFolders.js";

export const moveFolderTool = defineTool({
    name: "move_folder",
    label: "Move folder",
    description:
        "Move a folder to another place in the tree, the same way dragging it would. Say which folder it lands in and which sibling it lands below; Rig works out the ordering. Nothing moves on disk, and a folder cannot be moved inside itself.",
    arguments: Type.Object(
        {
            folder_id: Type.String({ description: "The folder to move." }),
            parent_id: Type.Optional(
                Type.String({
                    description:
                        "Folder it lands in. Omit to move it to the top level of the tree.",
                }),
            ),
            after_id: Type.Optional(
                Type.String({
                    description:
                        "Sibling it lands below. Omit to place it first among its new siblings.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: folderSchema,
    shouldReviewInAutoMode: () => false,
    execute: ({ after_id, folder_id, parent_id }, context) =>
        requireFolders(context).move(folder_id, {
            afterId: after_id ?? null,
            parentId: parent_id ?? null,
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Moved folder ${result.name}.`,
    locks: [],
});
