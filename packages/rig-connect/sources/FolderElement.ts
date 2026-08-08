import type { ConnectionState, MutationRejectedDelta } from "./ChatElement.js";
import type {
    Folder,
    SessionScope,
    SessionStatus,
    SessionSummary,
    SessionTokenCount,
    SessionUnreadState,
} from "./protocol.js";

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
    /** Chats directly contained by this folder, ordered independently of every other folder. */
    readonly sessions: readonly FolderSession[];
    /** Standing instructions every agent working in this folder must follow. */
    readonly rules?: string;
    readonly updatedAt: number;
}

export interface FolderSession {
    readonly archived: boolean;
    readonly createdAt: number;
    readonly cwd: string;
    readonly draft?: string;
    readonly draftUpdatedAt?: number;
    readonly effort?: string;
    readonly id: string;
    readonly lastMessageAt?: number;
    readonly modelId: string;
    readonly orderKey: string;
    readonly permissionMode: string;
    readonly providerId: string;
    readonly recap?: string;
    readonly scope: Extract<SessionScope, { kind: "folder" | "unsorted" }>;
    readonly serviceTier?: string;
    readonly sessionTokenCount?: SessionTokenCount;
    readonly status: SessionStatus;
    readonly title?: string;
    readonly trackUnread: boolean;
    readonly unread?: SessionUnreadState;
    readonly updatedAt: number;
    readonly wait?: { readonly dueAt: number; readonly startedAt: number };
}

/** Everything the folder area renders in one atomic application value. */
export interface FolderView {
    readonly folders: readonly FolderNode[];
    readonly unsorted: readonly FolderSession[];
}

/** Live facts about the folder tree as a whole. */
export interface FoldersState {
    readonly connection: ConnectionState;
}

/** What changed, for a consumer that reacts rather than re-rendering. */
export type FolderDelta =
    | { readonly type: "folders_changed"; readonly view: FolderView }
    | { readonly folderId: string; readonly type: "folder_added" }
    | { readonly folderId: string; readonly type: "folder_removed" }
    | { readonly sessionId: string; readonly type: "session_added" | "session_removed" }
    | { readonly state: FoldersState; readonly type: "folders_state_changed" }
    | MutationRejectedDelta;

/** Internal input shared by authoritative and optimistic projections. */
export type FolderSessionSource = Omit<SessionSummary, "ownerInstanceId"> & {
    readonly ownerInstanceId?: string;
};
