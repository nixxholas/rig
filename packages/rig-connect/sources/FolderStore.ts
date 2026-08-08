import type { FolderDelta, FolderNode, FoldersState } from "./FolderElement.js";
import type { Folder, GlobalEvent, GlobalStreamHello } from "./protocol.js";

/** The key children of the tree's root are collected under, which no folder id can be. */
const ROOT = "";

/**
 * Keeps the folder tree current from the global event stream.
 *
 * The daemon reports folders as one flat list whose nesting is carried by each folder's parent;
 * this joins them into the ordered tree a view draws and keeps that tree referentially stable, so
 * a React consumer re-renders only the branch that actually changed.
 */
export class FolderStore {
    #folders = new Map<string, Folder>();
    /** Cached node per folder, reused whenever neither it nor its subtree changed. */
    #nodes = new Map<
        string,
        { children: readonly FolderNode[]; source: Folder; value: FolderNode }
    >();
    #tree: readonly FolderNode[] = [];
    #treeStale = true;
    #state: FoldersState = { connection: "connecting" };

    /** The folders at the root of the tree, each carrying its own children. */
    folders(): readonly FolderNode[] {
        if (this.#treeStale) this.#rebuild();
        return this.#tree;
    }

    /** One folder as the daemon reports it, including one that has been archived. */
    folder(folderId: string): Folder | undefined {
        return this.#folders.get(folderId);
    }

    state(): FoldersState {
        return this.#state;
    }

    setConnection(connection: FoldersState["connection"]): FolderDelta[] {
        if (this.#state.connection === connection) return [];
        this.#state = { connection };
        return [{ state: this.#state, type: "folders_state_changed" }];
    }

    /**
     * Takes the tree carried by a catalog snapshot as the new base.
     *
     * A snapshot and the stream race, so a folder already known at a version at least as high is
     * kept rather than moved backwards, exactly as projects are.
     */
    applyHello(hello: GlobalStreamHello): FolderDelta[] {
        const previousTree = this.folders();
        const next = new Map<string, Folder>();
        const deltas: FolderDelta[] = [];
        let changed = false;
        for (const folder of hello.folders) {
            const known = this.#folders.get(folder.id);
            const kept = known !== undefined && known.version >= folder.version;
            if (!kept) {
                this.#nodes.delete(folder.id);
                changed = true;
            }
            const current = kept ? (known as Folder) : folder;
            next.set(folder.id, current);
            if (isVisible(current) && !isVisible(known)) {
                deltas.push({ folderId: folder.id, type: "folder_added" });
            }
        }
        for (const folder of this.#folders.values()) {
            if (next.has(folder.id)) continue;
            this.#nodes.delete(folder.id);
            changed = true;
            if (isVisible(folder)) deltas.push({ folderId: folder.id, type: "folder_removed" });
        }
        this.#folders = next;
        if (changed) this.#treeStale = true;
        const folders = this.folders();
        if (folders !== previousTree) {
            deltas.unshift({ folders, type: "folders_changed" });
        }
        return deltas;
    }

    apply(event: GlobalEvent): FolderDelta[] {
        if (event.type !== "folder_created" && event.type !== "folder_updated") return [];
        const { folder } = event.data as { folder: Folder };
        const known = this.#folders.get(folder.id);
        // A snapshot and the stream race, so an older copy must never overwrite a newer one.
        if (known !== undefined && known.version >= folder.version) return [];
        const previousTree = this.folders();
        this.#folders.set(folder.id, folder);
        this.#nodes.delete(folder.id);
        this.#treeStale = true;
        const deltas: FolderDelta[] = [];
        if (isVisible(folder) && !isVisible(known)) {
            deltas.push({ folderId: folder.id, type: "folder_added" });
        }
        if (!isVisible(folder) && isVisible(known)) {
            deltas.push({ folderId: folder.id, type: "folder_removed" });
        }
        const folders = this.folders();
        if (folders !== previousTree) deltas.unshift({ folders, type: "folders_changed" });
        return deltas;
    }

    #rebuild(): void {
        this.#treeStale = false;
        const visible = [...this.#folders.values()].filter(isVisible);
        const known = new Set(visible.map((folder) => folder.id));
        const childrenOf = new Map<string, Folder[]>();
        for (const folder of visible) {
            // A folder whose parent is not in the tree is drawn at the root rather than dropped:
            // losing it outright would hide work, and the daemon archives a whole subtree together
            // so this only happens while an update is still catching up.
            const parentId =
                folder.parentId !== undefined && known.has(folder.parentId)
                    ? folder.parentId
                    : ROOT;
            const siblings = childrenOf.get(parentId);
            if (siblings === undefined) childrenOf.set(parentId, [folder]);
            else siblings.push(folder);
        }
        for (const siblings of childrenOf.values()) siblings.sort(byOrderKey);
        this.#tree = this.#nodesUnder(ROOT, childrenOf, new Set());
    }

    #nodesUnder(
        parentId: string,
        childrenOf: Map<string, Folder[]>,
        open: Set<string>,
    ): readonly FolderNode[] {
        // `open` guards against a parent chain that loops. The daemon refuses a move that would
        // create one, so this only keeps a malformed tree from hanging the client.
        if (open.has(parentId)) return [];
        open.add(parentId);
        const nodes = (childrenOf.get(parentId) ?? []).map((folder) =>
            this.#node(folder, childrenOf, open),
        );
        open.delete(parentId);
        return nodes;
    }

    #node(folder: Folder, childrenOf: Map<string, Folder[]>, open: Set<string>): FolderNode {
        const children = this.#nodesUnder(folder.id, childrenOf, open);
        const cached = this.#nodes.get(folder.id);
        if (cached?.source === folder && sameNodes(cached.children, children)) return cached.value;
        const value: FolderNode = {
            children,
            createdAt: folder.createdAt,
            id: folder.id,
            name: folder.name,
            orderKey: folder.orderKey,
            path: folder.path,
            updatedAt: folder.updatedAt,
            ...(folder.archivedAt === undefined ? {} : { archivedAt: folder.archivedAt }),
            ...(folder.description === undefined ? {} : { description: folder.description }),
            ...(folder.icon === undefined ? {} : { icon: folder.icon }),
            ...(folder.parentId === undefined ? {} : { parentId: folder.parentId }),
            ...(folder.rules === undefined ? {} : { rules: folder.rules }),
        };
        this.#nodes.set(folder.id, { children, source: folder, value });
        return value;
    }
}

/** An archived folder is out of the tree a client draws, along with everything inside it. */
function isVisible(folder: Folder | undefined): boolean {
    return folder !== undefined && folder.archivedAt === undefined;
}

/**
 * Orders siblings by their position, and by identity when two share one.
 *
 * Without the second comparison, equal keys leave the order to whatever the sort happened to do,
 * and the list reshuffles under the reader.
 */
function byOrderKey(left: Folder, right: Folder): number {
    if (left.orderKey !== right.orderKey) return left.orderKey < right.orderKey ? -1 : 1;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** Whether two child lists hold the very same nodes in the same order. */
function sameNodes(before: readonly FolderNode[], after: readonly FolderNode[]): boolean {
    return before.length === after.length && before.every((node, index) => node === after[index]);
}
