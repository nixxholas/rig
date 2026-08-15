import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Bounds for a worklet source import. A worklet is code we install and run, so
 * the tree is copied exactly, but a source large enough to harm the daemon, a
 * symbolic link, or a special file is refused before anything is written.
 */
export const WORKLET_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
export const WORKLET_SOURCE_MAX_FILES = 10_000;
export const WORKLET_SOURCE_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** A source can be deep enough for ordinary TypeScript projects, but not stack-sized. */
export const WORKLET_SOURCE_MAX_DEPTH = 32;

/** A worklet source folder was rejected during verification or copying. */
export class WorkletInstallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "WorkletInstallError";
    }
}

interface CopyState {
    fileCount: number;
    directoryCount: number;
    totalBytes: number;
}

/**
 * Copies a verified worklet source tree into a fresh destination directory.
 * Every entry is `lstat`ed before it is copied: symbolic links, hard-linked
 * files, special files, oversized files, and source trees large enough to harm
 * the daemon are refused. The destination is created; its parent must already
 * exist.
 */
export async function copyWorkletTree(
    sourcePath: string,
    destinationPath: string,
): Promise<void> {
    if (!isAbsolute(sourcePath)) {
        throw new WorkletInstallError(
            "The worklet source path must be an absolute folder path on this machine.",
        );
    }
    if (!isAbsolute(destinationPath)) {
        throw new WorkletInstallError(
            "The worklet destination path must be absolute.",
        );
    }
    let sourceFacts;
    try {
        sourceFacts = await lstat(sourcePath);
    } catch {
        throw new WorkletInstallError(
            `The worklet source folder ${JSON.stringify(sourcePath)} does not exist.`,
        );
    }
    if (sourceFacts.isSymbolicLink() || !sourceFacts.isDirectory()) {
        throw new WorkletInstallError(
            `The worklet source ${JSON.stringify(sourcePath)} is not a folder.`,
        );
    }
    // Resolve the source once before walking it. The installer performs the
    // bidirectional source/install-root overlap check; this also rejects a
    // source whose final directory changes identity between lstat and opendir.
    let resolvedSource: string;
    try {
        resolvedSource = await realpath(sourcePath);
    } catch {
        throw new WorkletInstallError(
            `The worklet source folder ${JSON.stringify(sourcePath)} could not be resolved.`,
        );
    }
    const resolvedFacts = await lstat(resolvedSource);
    if (resolvedFacts.isSymbolicLink() || !resolvedFacts.isDirectory()) {
        throw new WorkletInstallError(
            `The worklet source ${JSON.stringify(sourcePath)} is not a real folder.`,
        );
    }
    let resolvedDestination: string;
    try {
        resolvedDestination = join(
            await realpath(dirname(destinationPath)),
            basename(destinationPath),
        );
    } catch {
        throw new WorkletInstallError(
            `The worklet destination folder ${JSON.stringify(destinationPath)} could not be resolved.`,
        );
    }
    if (pathsOverlap(resolvedSource, resolvedDestination)) {
        throw new WorkletInstallError(
            "The worklet source and destination must not contain one another.",
        );
    }
    // Count the source root as well: the entry budget covers the complete
    // hostile tree, not only the children returned by its first directory.
    const state: CopyState = { fileCount: 0, directoryCount: 1, totalBytes: 0 };
    await copyDirectory(resolvedSource, destinationPath, state, 0);
}

async function copyDirectory(
    sourcePath: string,
    destinationPath: string,
    state: CopyState,
    depth: number,
): Promise<void> {
    if (depth > WORKLET_SOURCE_MAX_DEPTH) {
        throw new WorkletInstallError(
            `The worklet source exceeds the ${String(WORKLET_SOURCE_MAX_DEPTH)}-level directory depth limit.`,
        );
    }
    await assertRealDirectory(dirname(destinationPath), "worklet destination parent");
    try {
        await mkdir(destinationPath);
    } catch {
        throw new WorkletInstallError(
            `The worklet destination folder ${JSON.stringify(destinationPath)} could not be created.`,
        );
    }
    await assertRealDirectory(destinationPath, "worklet destination folder");
    let directory;
    try {
        directory = await opendir(sourcePath);
    } catch {
        throw new WorkletInstallError(
            `The worklet source folder ${JSON.stringify(sourcePath)} could not be read.`,
        );
    }
    try {
        for await (const entry of directory) {
            if (!isSafeSourceEntryName(entry.name)) {
                throw new WorkletInstallError(
                    `The worklet source has an unsafe entry named ${JSON.stringify(entry.name)}.`,
                );
            }
            const sourceChild = join(sourcePath, entry.name);
            const destinationChild = join(destinationPath, entry.name);
            let facts;
            try {
                facts = await lstat(sourceChild);
            } catch {
                throw new WorkletInstallError(
                    `The worklet source entry ${JSON.stringify(sourceChild)} could not be read.`,
                );
            }
            if (facts.isSymbolicLink()) {
                throw new WorkletInstallError(
                    `The worklet source may not contain symbolic links (${JSON.stringify(sourceChild)}).`,
                );
            }
            if (facts.isDirectory()) {
                state.directoryCount += 1;
                assertTreeBounds(state);
                if (depth + 1 > WORKLET_SOURCE_MAX_DEPTH) {
                    throw new WorkletInstallError(
                        `The worklet source exceeds the ${String(WORKLET_SOURCE_MAX_DEPTH)}-level directory depth limit.`,
                    );
                }
                await copyDirectory(sourceChild, destinationChild, state, depth + 1);
                continue;
            }
            if (!facts.isFile()) {
                throw new WorkletInstallError(
                    `The worklet source has an unsupported entry at ${JSON.stringify(sourceChild)}.`,
                );
            }
            state.fileCount += 1;
            assertTreeBounds(state);
            await copyRegularFile(sourceChild, destinationChild, state);
        }
    } finally {
        await directory.close().catch(() => undefined);
    }
}

function assertTreeBounds(state: CopyState): void {
    if (state.fileCount + state.directoryCount > WORKLET_SOURCE_MAX_FILES) {
        throw new WorkletInstallError(
            "The worklet source exceeds the 10,000 files or directories, or 100 MiB import limit.",
        );
    }
}

/**
 * Read and write in bounded chunks. The source size is intentionally not used
 * as the accounting authority: a file can grow after lstat, and the bytes
 * actually read are what must remain under both limits.
 */
async function copyRegularFile(
    sourcePath: string,
    destinationPath: string,
    state: CopyState,
): Promise<void> {
    let source;
    let destination;
    try {
        source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        const sourceFacts = await source.stat();
        if (!sourceFacts.isFile() || sourceFacts.nlink > 1) {
            throw new WorkletInstallError(
                `The worklet source file ${JSON.stringify(sourcePath)} must be a single-link regular file.`,
            );
        }
        await assertRealDirectory(dirname(destinationPath), "worklet destination parent");
        destination = await open(
            destinationPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o644,
        );
        let fileBytes = 0;
        for (;;) {
            const chunk = Buffer.allocUnsafe(64 * 1024);
            const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            fileBytes += bytesRead;
            state.totalBytes += bytesRead;
            if (fileBytes > WORKLET_SOURCE_MAX_FILE_BYTES) {
                throw new WorkletInstallError(
                    `The worklet source file ${JSON.stringify(sourcePath)} exceeds the 10 MiB limit.`,
                );
            }
            if (state.totalBytes > WORKLET_SOURCE_MAX_BYTES) {
                throw new WorkletInstallError(
                    "The worklet source exceeds the 10,000 files or directories, or 100 MiB import limit.",
                );
            }
            await assertRealDirectory(dirname(destinationPath), "worklet destination parent");
            const destinationFacts = await lstat(destinationPath);
            if (destinationFacts.isSymbolicLink() || !destinationFacts.isFile()) {
                throw new WorkletInstallError(
                    `The worklet destination file ${JSON.stringify(destinationPath)} is not a regular file.`,
                );
            }
            await destination.write(chunk.subarray(0, bytesRead));
        }
    } catch (error: unknown) {
        if (error instanceof WorkletInstallError) throw error;
        throw new WorkletInstallError(
            `The worklet source file ${JSON.stringify(sourcePath)} could not be copied.`,
        );
    } finally {
        await source?.close().catch(() => undefined);
        await destination?.close().catch(() => undefined);
    }
}

async function assertRealDirectory(path: string, label: string): Promise<void> {
    let facts;
    try {
        facts = await lstat(path);
    } catch {
        throw new WorkletInstallError(`${label} ${JSON.stringify(path)} does not exist.`);
    }
    if (facts.isSymbolicLink() || !facts.isDirectory()) {
        throw new WorkletInstallError(`${label} ${JSON.stringify(path)} is not a real folder.`);
    }
    try {
        await realpath(path);
    } catch {
        throw new WorkletInstallError(`${label} ${JSON.stringify(path)} could not be resolved.`);
    }
}

/** Reads a regular file without following a final symlink, refusing anything past the limit. */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
    let file;
    try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const facts = await file.stat();
        if (!facts.isFile() || facts.nlink > 1) {
            await file.close().catch(() => undefined);
            file = undefined;
            throw new WorkletInstallError(
                `The worklet source file ${JSON.stringify(path)} must be a single-link regular file.`,
            );
        }
    } catch (error: unknown) {
        if (error instanceof WorkletInstallError) throw error;
        throw new WorkletInstallError(
            `The worklet source file ${JSON.stringify(path)} could not be opened.`,
        );
    }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
        for (;;) {
            const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
            const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) return Buffer.concat(chunks, length);
            chunks.push(chunk.subarray(0, bytesRead));
            length += bytesRead;
            if (length > maxBytes) {
                throw new WorkletInstallError(
                    `The worklet source file ${JSON.stringify(path)} exceeds its ${String(maxBytes)} byte limit.`,
                );
            }
        }
    } finally {
        await file.close().catch(() => undefined);
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

function pathsOverlap(left: string, right: string): boolean {
    return isContained(left, right) || isContained(right, left);
}

function isContained(root: string, target: string): boolean {
    const child = relative(resolve(root), resolve(target));
    return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}