import { lstat, open, rm } from "node:fs/promises";

export interface ProjectConfigPlaceholder {
    close(): Promise<void>;
    path: string;
}

export async function prepareProjectConfigPlaceholder(
    path: string,
): Promise<ProjectConfigPlaceholder | undefined> {
    let file: Awaited<ReturnType<typeof open>>;
    try {
        file = await open(path, "wx", 0o600);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") return undefined;
        throw error;
    }
    const created = await file.stat();
    await file.close();
    let closed = false;
    return {
        path,
        async close() {
            if (closed) return;
            closed = true;
            try {
                const current = await lstat(path);
                if (
                    current.isFile() &&
                    current.dev === created.dev &&
                    current.ino === created.ino &&
                    current.size === 0
                ) {
                    await rm(path);
                }
            } catch (error) {
                if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                    throw error;
                }
            }
        },
    };
}
