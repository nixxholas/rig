import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { FolderContext } from "../../agent/context/FolderContext.js";

export function requireFolders(context: AgentContext): FolderContext {
    if (context.folders === undefined) {
        throw new Error("Folders are not available in this conversation.");
    }
    return context.folders;
}
