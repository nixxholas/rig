import { Type } from "@sinclair/typebox";

import { defineTool } from "../../agent/types.js";
import { folderSchema } from "../../protocol/FolderProtocol.js";
import { requireFolders } from "./requireFolders.js";

export const listFoldersTool = defineTool({
    name: "list_folders",
    label: "List folders",
    description:
        "List the whole folder tree, parents before their children. Each folder reports the folder it sits in, its description and rules, and the directory holding its files.",
    arguments: Type.Object({}, { additionalProperties: false }),
    returnType: Type.Object({ folders: Type.Array(folderSchema) }, { additionalProperties: false }),
    shouldReviewInAutoMode: () => false,
    execute: (_arguments, context) => ({
        folders: requireFolders(context)
            .list()
            .map((folder) => ({ ...folder })),
    }),
    toLLM: (result) => [{ type: "text", text: JSON.stringify(result) }],
    toUI: (result) =>
        result.folders.length === 1
            ? "Found 1 folder."
            : `Found ${String(result.folders.length)} folders.`,
    locks: [],
});
