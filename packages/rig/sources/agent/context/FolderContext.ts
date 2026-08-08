import type {
    CreateFolderRequest,
    Folder,
    MoveFolderRequest,
    UpdateFolderRequest,
} from "../../protocol/FolderProtocol.js";

/**
 * How an agent reaches the folder tree.
 *
 * The chat this context belongs to is baked in by whoever builds it, so filing a chat away always
 * files this one: a tool can never move somebody else's conversation through its arguments.
 */
export interface FolderContext {
    create(request: CreateFolderRequest): Folder;
    /** The whole tree, parents before their children. */
    list(): readonly Folder[];
    move(folderId: string, request: MoveFolderRequest): Folder;
    /** Files this chat into a folder, or returns it to Unsorted with `null`. */
    setCurrentChatFolder(folderId: string | null): Folder | undefined;
    update(folderId: string, request: UpdateFolderRequest): Folder;
}
