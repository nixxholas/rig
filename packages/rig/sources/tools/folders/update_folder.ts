import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import {
    folderSchema,
    FOLDER_ICON_MAX_LENGTH,
    FOLDER_NAME_MAX_LENGTH,
    FOLDER_TEXT_MAX_LENGTH,
} from "../../protocol/FolderProtocol.js";
import { requireFolders } from "./requireFolders.js";

export const updateFolderTool = defineTool({
    name: "update_folder",
    label: "Update folder",
    description:
        "Change a folder's name, description, rules, or icon. Fields left out keep their current value; passing an empty string for the description, the rules, or the icon clears it.",
    arguments: Type.Object(
        {
            folder_id: Type.String({ description: "The folder to change." }),
            name: Type.Optional(
                Type.String({
                    description: "New name for the folder.",
                    maxLength: FOLDER_NAME_MAX_LENGTH,
                    minLength: 1,
                }),
            ),
            description: Type.Optional(
                Type.String({
                    description: "What this folder is for. An empty string clears it.",
                    maxLength: FOLDER_TEXT_MAX_LENGTH,
                }),
            ),
            rules: Type.Optional(
                Type.String({
                    description:
                        "Standing instructions for agents working in this folder. An empty string clears them.",
                    maxLength: FOLDER_TEXT_MAX_LENGTH,
                }),
            ),
            icon: Type.Optional(
                Type.String({
                    description:
                        "A single emoji shown next to the folder. An empty string clears it.",
                    maxLength: FOLDER_ICON_MAX_LENGTH,
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: folderSchema,
    shouldReviewInAutoMode: () => false,
    execute: ({ description, folder_id, icon, name, rules }, context) =>
        requireFolders(context).update(folder_id, {
            ...(name === undefined ? {} : { name }),
            ...(description === undefined
                ? {}
                : { description: description === "" ? null : description }),
            ...(rules === undefined ? {} : { rules: rules === "" ? null : rules }),
            ...(icon === undefined ? {} : { icon: icon === "" ? null : icon }),
        }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) => `Updated folder ${result.name}.`,
    locks: [],
});
