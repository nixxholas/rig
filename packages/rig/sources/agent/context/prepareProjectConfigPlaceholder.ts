import { lstat, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface GitExcludeTarget {
    created?: Stats;
    path: string;
}

interface ActiveProjectConfigPlaceholder {
    created: Stats;
    gitExclude?: GitExcludeTarget;
    references: number;
}

const activePlaceholders = new Map<string, ActiveProjectConfigPlaceholder>();
const pathLocks = new Map<string, Promise<void>>();

export interface ProjectConfigPlaceholder {
    close(): Promise<void>;
    gitExclude?: {
        path: string;
        sourcePath: string;
    };
    path: string;
    sourcePath: string;
}

export async function prepareProjectConfigPlaceholder(
    path: string,
    gitExcludePath?: string,
): Promise<ProjectConfigPlaceholder | undefined> {
    return withPathLock(path, async () => {
        let state = activePlaceholders.get(path);
        if (state === undefined) {
            let target: Awaited<ReturnType<typeof open>>;
            try {
                target = await open(path, "wx", 0o600);
            } catch (error) {
                if (error instanceof Error && "code" in error && error.code === "EEXIST") {
                    return undefined;
                }
                throw error;
            }
            const created = await target.stat();
            await target.close();
            try {
                const createdState: ActiveProjectConfigPlaceholder = {
                    created,
                    references: 0,
                };
                if (gitExcludePath !== undefined) {
                    createdState.gitExclude = await prepareGitExcludeTarget(gitExcludePath);
                }
                state = createdState;
                activePlaceholders.set(path, createdState);
            } catch (error) {
                await removeOwnedTarget(path, created);
                throw error;
            }
        } else {
            const current = await lstat(path).catch((error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") {
                    throw new Error(
                        "The project rig.toml placeholder disappeared during command startup.",
                    );
                }
                throw error;
            });
            if (!sameEmptyFile(current, state.created)) return undefined;
            if (state.gitExclude?.path !== gitExcludePath) {
                throw new Error(
                    "The Git exclude path changed while restricted commands were starting.",
                );
            }
        }

        if (state === undefined) throw new Error("Could not prepare the project config mask.");
        state.references += 1;
        try {
            return await createHandle(path, state);
        } catch (error) {
            await releasePlaceholder(path, state);
            throw error;
        }
    });
}

async function createHandle(
    path: string,
    state: ActiveProjectConfigPlaceholder,
): Promise<ProjectConfigPlaceholder> {
    const directory = await mkdtemp(join(tmpdir(), "rig-project-config-"));
    const sourcePath = join(directory, "rig.toml");
    try {
        const source = await open(sourcePath, "wx", 0o600);
        await source.close();
        if (state.gitExclude !== undefined) {
            const existing = await readFile(state.gitExclude.path);
            const separator =
                existing.length === 0 || existing.at(-1) === 0x0a
                    ? Buffer.alloc(0)
                    : Buffer.from("\n");
            await writeFile(
                join(directory, "git-exclude"),
                Buffer.concat([existing, separator, Buffer.from("/rig.toml\n")]),
                { mode: 0o600 },
            );
        }
    } catch (error) {
        await rm(directory, { force: true, recursive: true });
        throw error;
    }

    let closed = false;
    return {
        ...(state.gitExclude === undefined
            ? {}
            : {
                  gitExclude: {
                      path: state.gitExclude.path,
                      sourcePath: join(directory, "git-exclude"),
                  },
              }),
        path,
        sourcePath,
        async close() {
            if (closed) return;
            closed = true;
            const results = await Promise.allSettled([
                rm(directory, { force: true, recursive: true }),
                withPathLock(path, () => releasePlaceholder(path, state)),
            ]);
            const errors = results.flatMap((result) =>
                result.status === "rejected" ? [result.reason] : [],
            );
            if (errors.length > 0) {
                throw new AggregateError(errors, "Could not clean up the project config mask.");
            }
        },
    };
}

async function prepareGitExcludeTarget(path: string): Promise<GitExcludeTarget> {
    let created: Stats | undefined;
    try {
        const target = await open(path, "wx", 0o600);
        created = await target.stat();
        await target.close();
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    return { ...(created === undefined ? {} : { created }), path };
}

async function releasePlaceholder(
    path: string,
    state: ActiveProjectConfigPlaceholder,
): Promise<void> {
    state.references -= 1;
    if (state.references > 0) return;
    if (activePlaceholders.get(path) === state) activePlaceholders.delete(path);
    const results = await Promise.allSettled([
        removeOwnedTarget(path, state.created),
        state.gitExclude?.created === undefined
            ? Promise.resolve()
            : removeOwnedTarget(state.gitExclude.path, state.gitExclude.created),
    ]);
    const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length > 0) {
        throw new AggregateError(errors, "Could not remove an owned project config mount target.");
    }
}

async function removeOwnedTarget(path: string, created: Stats): Promise<void> {
    try {
        const current = await lstat(path);
        if (sameEmptyFile(current, created)) await rm(path);
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
}

function sameEmptyFile(current: Stats, created: Stats): boolean {
    return (
        current.isFile() &&
        current.dev === created.dev &&
        current.ino === created.ino &&
        current.size === 0
    );
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
