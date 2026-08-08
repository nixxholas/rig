import { constants } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
    FileSystemContext,
    FileSystemReadOptions,
    FileSystemStat,
} from "../agent/context/FileSystemContext.js";

export const IMPORTED_SOURCE_MAX_BYTES = 100 * 1024 * 1024;
export const IMPORTED_SOURCE_MAX_FILES = 10_000;
export const IMPORTED_SOURCE_MAX_FILE_BYTES = 10 * 1024 * 1024;

export interface ImportedSourceReader {
    lstat(path: string): Promise<FileSystemStat>;
    readFileBuffer(path: string, options?: FileSystemReadOptions): Promise<Uint8Array>;
    readdir(path: string): Promise<readonly string[]>;
}

export interface ImportedTreeWriter {
    mkdir(path: string, options: { recursive: true }): Promise<unknown>;
    writeFile(path: string, content: Uint8Array): Promise<void>;
}

/**
 * What the thing being imported is called in the messages a person reads, and the error the caller
 * wants raised. Applets and worklets are separate concepts with their own failure types, so the
 * copy itself stays neutral about both.
 */
export interface ImportedTreeSubject {
    invalid(message: string): Error;
    subject: string;
}

interface CopyState {
    fileCount: number;
    totalBytes: number;
}

const hostSourceReader: ImportedSourceReader = {
    async lstat(path) {
        const facts = await lstat(path);
        return {
            isDirectory: facts.isDirectory(),
            isFile: facts.isFile(),
            isSymbolicLink: facts.isSymbolicLink(),
            mtimeMs: facts.mtimeMs,
            size: facts.size,
        };
    },
    readFileBuffer: async (path, options) => {
        if (options?.noFollow !== true && options?.maxBytes === undefined) return readFile(path);
        return readHostSourceFile(
            path,
            options?.maxBytes ?? Number.MAX_SAFE_INTEGER,
            options?.noFollow === true,
        );
    },
    readdir,
};

async function readHostSourceFile(
    path: string,
    maxBytes: number,
    noFollow: boolean,
): Promise<Buffer> {
    const file = await open(
        path,
        noFollow ? constants.O_RDONLY | constants.O_NOFOLLOW : constants.O_RDONLY,
    );
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
        throw new Error(`The file exceeds the ${String(maxBytes)} byte limit.`);
    } finally {
        await file.close();
    }
}

/** Uses the host filesystem for HTTP imports, or an agent/Docker filesystem when supplied. */
export function resolveImportedSourceReader(
    reader: FileSystemContext | ImportedSourceReader | undefined,
): ImportedSourceReader {
    return reader ?? hostSourceReader;
}

/**
 * Copies an imported source tree into an already-created destination. Every source entry is
 * lstat'd and bounded before it is copied: symlinks, special files, oversized files, and source
 * trees large enough to harm the daemon are refused.
 */
export async function copyImportedTree(
    sourcePath: string,
    destinationPath: string,
    sourceReader: ImportedSourceReader,
    write: ImportedTreeWriter,
    of: ImportedTreeSubject,
): Promise<void> {
    if (!isAbsolute(sourcePath)) {
        throw of.invalid(
            `The ${of.subject} source path must be an absolute folder path on this machine.`,
        );
    }
    let sourceFacts;
    try {
        sourceFacts = await sourceReader.lstat(sourcePath);
    } catch {
        throw of.invalid(
            `The ${of.subject} source folder ${JSON.stringify(sourcePath)} does not exist.`,
        );
    }
    if (sourceFacts.isSymbolicLink || !sourceFacts.isDirectory) {
        throw of.invalid(`The ${of.subject} source ${JSON.stringify(sourcePath)} is not a folder.`);
    }

    const state: CopyState = { fileCount: 0, totalBytes: 0 };
    await copyDirectory(sourcePath, destinationPath, sourceReader, write, of, state);
}

async function copyDirectory(
    sourcePath: string,
    destinationPath: string,
    sourceReader: ImportedSourceReader,
    write: ImportedTreeWriter,
    of: ImportedTreeSubject,
    state: CopyState,
): Promise<void> {
    await write.mkdir(destinationPath, { recursive: true });
    let entries;
    try {
        entries = await sourceReader.readdir(sourcePath);
    } catch {
        throw of.invalid(
            `The ${of.subject} source folder ${JSON.stringify(sourcePath)} could not be read.`,
        );
    }
    for (const entry of [...entries].sort()) {
        if (!isSafeSourceEntryName(entry)) {
            throw of.invalid(
                `The ${of.subject} source has an unsafe entry named ${JSON.stringify(entry)}.`,
            );
        }
        const sourceChild = join(sourcePath, entry);
        const destinationChild = join(destinationPath, entry);
        let facts;
        try {
            facts = await sourceReader.lstat(sourceChild);
        } catch {
            throw of.invalid(
                `The ${of.subject} source entry ${JSON.stringify(sourceChild)} could not be read.`,
            );
        }
        if (facts.isSymbolicLink) {
            throw of.invalid(
                `The ${of.subject} source may not contain symbolic links (${JSON.stringify(sourceChild)}).`,
            );
        }
        if (facts.isDirectory) {
            await copyDirectory(sourceChild, destinationChild, sourceReader, write, of, state);
            continue;
        }
        if (!facts.isFile) {
            throw of.invalid(
                `The ${of.subject} source has an unsupported entry at ${JSON.stringify(sourceChild)}.`,
            );
        }
        if (facts.size > IMPORTED_SOURCE_MAX_FILE_BYTES) {
            throw of.invalid(
                `The ${of.subject} source file ${JSON.stringify(sourceChild)} exceeds the 10 MiB limit.`,
            );
        }
        state.fileCount += 1;
        state.totalBytes += facts.size;
        if (
            state.fileCount > IMPORTED_SOURCE_MAX_FILES ||
            state.totalBytes > IMPORTED_SOURCE_MAX_BYTES
        ) {
            throw of.invalid(
                `The ${of.subject} source exceeds the 10,000-file or 100 MiB import limit.`,
            );
        }
        try {
            const bytes = await sourceReader.readFileBuffer(sourceChild, {
                maxBytes: IMPORTED_SOURCE_MAX_FILE_BYTES,
                noFollow: true,
            });
            if (bytes.byteLength > IMPORTED_SOURCE_MAX_FILE_BYTES) {
                throw new Error("Source reader ignored the byte limit.");
            }
            await write.writeFile(destinationChild, bytes);
        } catch {
            throw of.invalid(
                `The ${of.subject} source file ${JSON.stringify(sourceChild)} could not be copied.`,
            );
        }
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
