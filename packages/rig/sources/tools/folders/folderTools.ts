import { createFolderTool } from "./create_folder.js";
import { listFoldersTool } from "./list_folders.js";
import { moveFolderTool } from "./move_folder.js";
import { setChatFolderTool } from "./set_chat_folder.js";
import { updateFolderTool } from "./update_folder.js";

export const folderTools = [
    createFolderTool,
    listFoldersTool,
    updateFolderTool,
    moveFolderTool,
    setChatFolderTool,
] as const;
