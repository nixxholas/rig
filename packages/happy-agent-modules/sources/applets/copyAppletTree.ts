import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

/** How many source entries and bytes one applet import may copy. */
export interface AppletTreeBounds {
    readonly maxFiles: number;
    readonly maxBytes: number;
    readonly maxFileBytes: number;
}

export interface AppletTreeCopyResult {
    readonly fileCount: number;
    readonly byteCount: number;
}

interface CopyState {
    fileCount: number;
    byteCount: number;
}

/**
 * Copies a static applet source tree into an already-created destination.
 *
 * Every source entry is `lstat`'d and bounded before it is copied: symbolic
 * links, special files, oversized files, and source trees large enough to harm
 * the daemon are refused. Files are opened with `O_NOFOLLOW` so a race that
 * swaps a regular file for a symlink after the stat cannot escape the tree.
 */
export async function copyAppletTree(
    sourcePath: string,
    destinationPath: string,
    bounds: AppletTreeBounds,
): Promise<AppletTreeCopyResult> {
    if (!isAbsolute(sourcePath)) {
        throw new Error("The applet source path must be an absolute folder path on this machine.");
    }
    let sourceFacts;
    try {
        sourceFacts = await lstat(sourcePath);
    } catch {
        throw new Error(`The applet source folder ${JSON.stringify(sourcePath)} does not exist.`);
    }
    if (sourceFacts.isSymbolicLink() || !sourceFacts.isDirectory()) {
        throw new Error(`The applet source ${JSON.stringify(sourcePath)} is not a folder.`);
    }

    const state: CopyState = { fileCount: 0, byteCount: 0 };
    await copyDirectory(sourcePath, destinationPath, bounds, state);
    return { fileCount: state.fileCount, byteCount: state.byteCount };
}

async function copyDirectory(
    sourcePath: string,
    destinationPath: string,
    bounds: AppletTreeBounds,
    state: CopyState,
): Promise<void> {
    await mkdir(destinationPath, { recursive: true });
    let entries: readonly string[];
    try {
        entries = await readdir(sourcePath);
    } catch {
        throw new Error(`The applet source folder ${JSON.stringify(sourcePath)} could not be read.`);
    }
    for (const entry of [...entries].sort()) {
        if (!isSafeSourceEntryName(entry)) {
            throw new Error(
                `The applet source has an unsafe entry named ${JSON.stringify(entry)}.`,
            );
        }
        const sourceChild = join(sourcePath, entry);
        const destinationChild = join(destinationPath, entry);
        let facts;
        try {
            facts = await lstat(sourceChild);
        } catch {
            throw new Error(
                `The applet source entry ${JSON.stringify(sourceChild)} could not be read.`,
            );
        }
        if (facts.isSymbolicLink()) {
            throw new Error(
                `The applet source may not contain symbolic links (${JSON.stringify(sourceChild)}).`,
            );
        }
        if (facts.isDirectory()) {
            await copyDirectory(sourceChild, destinationChild, bounds, state);
            continue;
        }
        if (!facts.isFile()) {
            throw new Error(
                `The applet source has an unsupported entry at ${JSON.stringify(sourceChild)}.`,
            );
        }
        if (facts.size > bounds.maxFileBytes) {
            throw new Error(
                `The applet source file ${JSON.stringify(sourceChild)} exceeds the per-file byte limit.`,
            );
        }
        state.fileCount += 1;
        state.byteCount += facts.size;
        if (state.fileCount > bounds.maxFiles || state.byteCount > bounds.maxBytes) {
            throw new Error("The applet source exceeds the file-count or total-byte import limit.");
        }
        const bytes = await readRegularFile(sourceChild, bounds.maxFileBytes);
        await writeFile(destinationChild, bytes);
    }
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        while (length <= maxBytes) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
        }
        throw new Error(`The applet source file ${JSON.stringify(path)} exceeds the byte limit.`);
    } finally {
        await file.close();
    }
}

function isSafeSourceEntryName(value: string): boolean {
    return (
        value.length > 0 &&
        value !== "." &&
        value !== ".." &&
        !value.includes("/") &&
        !value.includes("\\") &&
        !value.includes("\0")
    );
}
