import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { folderSchema } from "../../protocol/FolderProtocol.js";
import { requireFolders } from "./requireFolders.js";

export const setChatFolderTool = defineTool({
    name: "set_chat_folder",
    label: "File chat into folder",
    description:
        "Put this conversation into one of the folders. A chat that starts out belonging nowhere sits in Unsorted and is put away after a day, so file it as soon as it is clear what the work is about. Omitting the folder returns this chat to Unsorted.",
    arguments: Type.Object(
        {
            folder_id: Type.Optional(
                Type.String({
                    description:
                        "The folder this conversation belongs in. Omit to return it to Unsorted.",
                }),
            ),
        },
        { additionalProperties: false },
    ),
    returnType: Type.Object(
        { folder: Type.Optional(folderSchema) },
        { additionalProperties: false },
    ),
    shouldReviewInAutoMode: () => false,
    execute: ({ folder_id }, context) => {
        const folder = requireFolders(context).setCurrentChatFolder(folder_id ?? null);
        return folder === undefined ? {} : { folder };
    },
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.folder === undefined
            ? "Moved this chat back to Unsorted."
            : `Filed this chat into ${result.folder.name}.`,
    locks: [],
});
