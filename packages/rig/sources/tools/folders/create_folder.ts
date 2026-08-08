import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import {
    folderSchema,
    FOLDER_ICON_MAX_LENGTH,
    FOLDER_NAME_MAX_LENGTH,
    FOLDER_TEXT_MAX_LENGTH,
} from "../../protocol/FolderProtocol.js";
import { requireFolders } from "./requireFolders.js";

export const createFolderTool = defineTool({
    name: "create_folder",
    label: "Create folder",
    description:
        "Create a folder in the tree the user works in. A folder holds files, documents, and the chats that produce them. Nesting is virtual: a folder placed inside another is only shown that way, and nothing moves on disk.",
    arguments: Type.Object(
        {
            name: Type.String({
                description: "Short human-readable name, written the way a person would write it.",
                maxLength: FOLDER_NAME_MAX_LENGTH,
                minLength: 1,
            }),
            description: Type.Optional(
                Type.String({
                    description: "What this folder is for, in a sentence or two.",
                    maxLength: FOLDER_TEXT_MAX_LENGTH,
                }),
            ),
            rules: Type.Optional(
                Type.String({
                    description:
                        "Standing instructions every agent working in this folder must follow.",
                    maxLength: FOLDER_TEXT_MAX_LENGTH,
                }),
            ),
            icon: Type.Optional(
                Type.String({
                    description: "A single emoji shown next to the folder.",
                    maxLength: FOLDER_ICON_MAX_LENGTH,
                }),
            ),
            parent_id: Type.Optional(
                Type.String({
                    description:
                        "Folder to place this one inside. Omit to put it at the top level.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: folderSchema,
    shouldReviewInAutoMode: () => false,
    execute: ({ description, icon, name, parent_id, rules }, context) =>
        requireFolders(context).create({
            name,
            ...(description === undefined ? {} : { description }),
            ...(icon === undefined ? {} : { icon }),
            ...(parent_id === undefined ? {} : { parentId: parent_id }),
            ...(rules === undefined ? {} : { rules }),
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Created folder ${result.name}.`,
    locks: [],
});
