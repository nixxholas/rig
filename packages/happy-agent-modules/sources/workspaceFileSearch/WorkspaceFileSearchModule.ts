import { resolve } from "node:path";

import type { FileFinder } from "@ff-labs/fff-node";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const DEFAULT_MAX_INDEXES = 8;
const INITIAL_SCAN_TIMEOUT_MS = 5_000;
const MAX_SEARCH_RESULTS = 50;
/** How old an index may be before a search triggers a rescan of the workspace. */
const RESCAN_AFTER_MS = 2_000;
/** How long one search waits for that rescan before serving the index it already has. */
const RESCAN_WAIT_MS = 1_000;

export const fileSearchQuerySchema = Type.Object(
    {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH_RESULTS })),
        query: Type.String({ maxLength: 512 }),
    },
    { additionalProperties: false },
);

export type FileSearchQuery = Static<typeof fileSearchQuerySchema>;

export interface FileSearchResult {
    readonly files: readonly { readonly fileName: string; readonly path: string }[];
}

interface FinderState {
    readonly finder: FileFinder;
    readonly ready: Promise<void>;
    /** When the index was last brought up to date with the filesystem. */
    lastScanAt: number;
}

/**
 * Keeps a bounded collection of live fuzzy indexes, one for each recently searched workspace.
 */
export class WorkspaceFileSearchModule {
    readonly #finders = new Map<string, FinderState>();
    readonly #maxIndexes = DEFAULT_MAX_INDEXES;
    #fileFinderConstructor: Promise<typeof import("@ff-labs/fff-node").FileFinder> | undefined;

    close(): void {
        for (const state of this.#finders.values()) {
            state.finder.destroy();
        }
        this.#finders.clear();
    }

    async search(root: string, query: FileSearchQuery): Promise<FileSearchResult> {
        if (!Value.Check(fileSearchQuerySchema, query)) {
            throw new WorkspaceFileSearchError("The file search query is invalid.");
        }
        const FileFinderConstructor = await this.#loadFileFinder();
        const state = this.#finderFor(root, FileFinderConstructor);
        await state.ready;
        // The background watcher can miss external changes, so an aging index is rescanned
        // before answering; a slow rescan degrades to the index already in hand.
        if (Date.now() - state.lastScanAt > RESCAN_AFTER_MS && !state.finder.isScanning()) {
            state.lastScanAt = Date.now();
            if (state.finder.scanFiles().ok) {
                await state.finder.waitForScan(RESCAN_WAIT_MS).catch(() => undefined);
            }
        }

        const result = state.finder.fileSearch(query.query, {
            pageSize: query.limit ?? MAX_SEARCH_RESULTS,
        });
        if (!result.ok) {
            throw new WorkspaceFileSearchError(`File search failed: ${result.error}`);
        }

        return {
            files: result.value.items.map((item) => ({
                fileName: item.fileName,
                path: item.relativePath,
            })),
        };
    }

    #finderFor(
        root: string,
        FileFinderConstructor: typeof import("@ff-labs/fff-node").FileFinder,
    ): FinderState {
        const basePath = resolve(root);
        const existing = this.#finders.get(basePath);
        if (existing !== undefined) {
            this.#finders.delete(basePath);
            this.#finders.set(basePath, existing);
            return existing;
        }

        const created = FileFinderConstructor.create({
            aiMode: true,
            basePath,
            disableContentIndexing: true,
            disableMmapCache: true,
        });
        if (!created.ok) {
            throw new WorkspaceFileSearchError(
                `File search could not index this workspace: ${created.error}`,
            );
        }

        const finder = created.value;
        const state: FinderState = {
            finder,
            lastScanAt: Date.now(),
            ready: finder.waitForScan(INITIAL_SCAN_TIMEOUT_MS).then((result) => {
                if (!result.ok) {
                    throw new WorkspaceFileSearchError(
                        `File search could not scan this workspace: ${result.error}`,
                    );
                }
            }),
        };
        this.#finders.set(basePath, state);
        this.#removeOldestIndex();
        return state;
    }

    #removeOldestIndex(): void {
        if (this.#finders.size <= this.#maxIndexes) return;

        const oldestPath = this.#finders.keys().next().value as string | undefined;
        if (oldestPath === undefined) return;

        const oldest = this.#finders.get(oldestPath);
        this.#finders.delete(oldestPath);
        oldest?.finder.destroy();
    }

    async #loadFileFinder(): Promise<typeof import("@ff-labs/fff-node").FileFinder> {
        this.#fileFinderConstructor ??= import("@ff-labs/fff-node").then(
            ({ FileFinder: FileFinderConstructor }) => FileFinderConstructor,
        );
        return await this.#fileFinderConstructor;
    }
}

export class WorkspaceFileSearchError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkspaceFileSearchError";
    }
}
