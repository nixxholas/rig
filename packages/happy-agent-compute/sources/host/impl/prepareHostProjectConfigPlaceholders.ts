import { lstat, open, rm, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { dirname } from "node:path";

interface ActivePlaceholder {
    created: Stats;
    references: number;
    target: FileHandle;
}

export interface HostProjectConfigPlaceholder {
    close(): Promise<void>;
    path: string;
}

const activePlaceholders = new Map<string, ActivePlaceholder>();
const pathLocks = new Map<string, Promise<void>>();

/**
 * Reserves absent project policy files with an owned empty inode.
 *
 * The native supervisor can protect an existing path, but it cannot mount a path that does not
 * exist. Reserving the file before the policy is built closes the create/read race between
 * concurrent restricted commands. A placeholder is removed only when its inode is still the
 * empty file this helper created; user content is never discarded.
 */
export async function prepareHostProjectConfigPlaceholders(
    paths: readonly string[],
): Promise<readonly HostProjectConfigPlaceholder[]> {
    const placeholders: HostProjectConfigPlaceholder[] = [];
    try {
        for (const path of new Set(paths)) {
            const placeholder = await prepareOne(path);
            if (placeholder !== undefined) placeholders.push(placeholder);
        }
        return placeholders;
    } catch (error) {
        await Promise.allSettled(placeholders.map((placeholder) => placeholder.close()));
        throw error;
    }
}

async function prepareOne(path: string): Promise<HostProjectConfigPlaceholder | undefined> {
    return withPathLock(path, async () => {
        let state = activePlaceholders.get(path);
        if (state === undefined) {
            try {
                const parent = dirname(path);
                if ((await lstat(parent)).isSymbolicLink()) {
                    throw new Error(
                        `Restricted host commands cannot reserve a project policy through a symbolic-link directory: ${parent}.`,
                    );
                }
            } catch (error) {
                if (isCode(error, "ENOENT")) return undefined;
                throw error;
            }
            let target: FileHandle;
            try {
                target = await open(path, "wx", 0o600);
            } catch (error) {
                if (isCode(error, "EEXIST")) return undefined;
                if (isCode(error, "ENOENT")) return undefined;
                throw error;
            }
            const created = await target.stat();
            state = { created, references: 0, target };
            activePlaceholders.set(path, state);
        } else {
            const current = await lstat(path).catch((error: unknown) => {
                if (isCode(error, "ENOENT")) {
                    throw new Error(
                        `The host project policy placeholder disappeared during command startup: ${path}`,
                    );
                }
                throw error;
            });
            if (!sameEmptyFile(current, state.created)) return undefined;
        }

        state.references += 1;
        let closed = false;
        try {
            return {
                path,
                async close() {
                    if (closed) return;
                    closed = true;
                    await withPathLock(path, () => releasePlaceholder(path, state!));
                },
            };
        } catch (error) {
            await releasePlaceholder(path, state);
            throw error;
        }
    });
}

async function releasePlaceholder(path: string, state: ActivePlaceholder): Promise<void> {
    state.references -= 1;
    if (state.references > 0) return;
    if (activePlaceholders.get(path) === state) activePlaceholders.delete(path);
    const errors: unknown[] = [];
    try {
        await removeOwnedTarget(path, state.created);
    } catch (error) {
        errors.push(error);
    }
    try {
        await state.target.close();
    } catch (error) {
        errors.push(error);
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "Could not remove an owned host project policy target.");
    }
}

async function removeOwnedTarget(path: string, created: Stats): Promise<void> {
    try {
        const current = await lstat(path);
        if (sameEmptyFile(current, created)) await rm(path, { force: true });
    } catch (error) {
        if (!isCode(error, "ENOENT")) throw error;
    }
}

function sameEmptyFile(current: Stats, created: Stats): boolean {
    return (
        current.isFile() &&
        current.dev === created.dev &&
        current.ino === created.ino &&
        current.size === 0 &&
        current.mode === created.mode &&
        current.uid === created.uid &&
        current.gid === created.gid &&
        current.mtimeMs === created.mtimeMs &&
        current.ctimeMs === created.ctimeMs
    );
}

function isCode(error: unknown, code: string): boolean {
    return error instanceof Error && "code" in error && error.code === code;
}

async function withPathLock<T>(path: string, action: () => Promise<T>): Promise<T> {
    const previous = pathLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = previous.then(
        () =>
            new Promise<void>((resolve) => {
                release = resolve;
            }),
    );
    pathLocks.set(path, current);
    await previous;
    try {
        return await action();
    } finally {
        release();
        if (pathLocks.get(path) === current) pathLocks.delete(path);
    }
}
