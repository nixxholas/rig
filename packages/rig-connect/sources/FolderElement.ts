import type { ConnectionState } from "./ChatElement.js";
import type { Folder } from "./protocol.js";

export type { Folder };

/**
 * One folder with the folders nested inside it already joined.
 *
 * The daemon reports the tree as a flat list every client then has to assemble; doing it once here
 * is the point of the library. `children` is ordered the way the folders should be drawn, and
 * `path` is the flat storage directory the folder owns, which never moves when the tree does.
 */
export interface FolderNode {
    readonly archivedAt?: number;
    readonly children: readonly FolderNode[];
    readonly createdAt: number;
    /** What the folder is for, shown to people and given to agents working inside it. */
    readonly description?: string;
    /** A single emoji, when the folder has one. */
    readonly icon?: string;
    readonly id: string;
    readonly name: string;
    /** Where this folder sits among its siblings. Only the daemon ever writes it. */
    readonly orderKey: string;
    /** Absent for a folder at the root of the tree. */
    readonly parentId?: string;
    /** Flat storage directory holding this folder's files. */
    readonly path: string;
    /** Standing instructions every agent working in this folder must follow. */
    readonly rules?: string;
    readonly updatedAt: number;
}

/** Live facts about the folder tree as a whole. */
export interface FoldersState {
    readonly connection: ConnectionState;
}

/** What changed, for a consumer that reacts rather than re-rendering. */
export type FolderDelta =
    | { readonly folders: readonly FolderNode[]; readonly type: "folders_changed" }
    | { readonly folderId: string; readonly type: "folder_added" }
    | { readonly folderId: string; readonly type: "folder_removed" }
    | { readonly state: FoldersState; readonly type: "folders_state_changed" };
