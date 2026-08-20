import { resolve } from "node:path";

import type { FileFinder } from "@ff-labs/fff-node";

const DEFAULT_MAX_INDEXES = 8;
const RESCAN_AFTER_MS = 2_000;
const SEARCH_READY_BUDGET_MS = 100;

interface FinderState {
    readonly finder: FileFinder;
    lastScanAt: number;
}

export class WorkspaceFileIndex {
    readonly #finders = new Map<string, FinderState>();
    readonly #maxIndexes = DEFAULT_MAX_INDEXES;
    #fileFinderConstructor: Promise<typeof import("@ff-labs/fff-node").FileFinder> | undefined;

    close(): void {
        for (const state of this.#finders.values()) {
            state.finder.destroy();
        }
        this.#finders.clear();
    }

    refresh(root: string): void {
        const state = this.#finders.get(resolve(root));
        if (state === undefined) return;
        this.#startScan(state);
    }

    /** Requests a scan only when a file proven by a direct read is absent from a warm index. */
    ensure(root: string, path: string): void {
        const state = this.#finders.get(resolve(root));
        if (state === undefined || state.finder.isScanning()) return;
        const result = state.finder.fileSearch(path, { pageSize: 10 });
        if (!result.ok) return;
        if (!result.value.items.some((item) => item.relativePath === path)) {
            this.#startScan(state);
        }
    }

    async search(
        root: string,
        query: string,
        limit: number,
    ): Promise<readonly { readonly fileName: string; readonly path: string }[]> {
        const state = await this.#stateFor(root);
        if (Date.now() - state.lastScanAt > RESCAN_AFTER_MS) this.#startScan(state);
        if (state.finder.isScanning()) {
            await this.#waitForScan(state.finder, SEARCH_READY_BUDGET_MS);
        }
        const result = state.finder.fileSearch(query, { pageSize: limit });
        if (!result.ok) throw new Error(`File search failed: ${result.error}`);

        return result.value.items.map((item) => ({
            fileName: item.fileName,
            path: item.relativePath,
        }));
    }

    async #stateFor(root: string): Promise<FinderState> {
        const basePath = resolve(root);
        const existing = this.#finders.get(basePath);
        if (existing !== undefined) {
            this.#finders.delete(basePath);
            this.#finders.set(basePath, existing);
            return existing;
        }

        const FileFinderConstructor = await this.#loadFileFinder();
        const created = FileFinderConstructor.create({
            aiMode: true,
            basePath,
            disableContentIndexing: true,
            disableMmapCache: true,
        });
        if (!created.ok) {
            throw new Error(`Workspace files could not be indexed: ${created.error}`);
        }

        const finder = created.value;
        const state: FinderState = { finder, lastScanAt: Date.now() };
        this.#finders.set(basePath, state);
        this.#removeOldestIndex();
        return state;
    }

    async #waitForScan(finder: FileFinder, timeoutMs: number): Promise<void> {
        await finder.waitForScan(timeoutMs).catch(() => undefined);
    }

    #startScan(state: FinderState): void {
        if (state.finder.isScanning()) return;
        if (state.finder.scanFiles().ok) state.lastScanAt = Date.now();
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
