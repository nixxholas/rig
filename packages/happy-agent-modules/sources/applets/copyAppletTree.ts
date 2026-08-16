import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { MAX_APPLET_SOURCE_FILE_BYTES, MAX_APPLET_SOURCE_FILES } from "./Applet.js";

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

export interface AppletTreeFile {
    readonly path: string;
    readonly bytes: Uint8Array;
}

export interface AppletTreeReadResult {
    readonly files: readonly AppletTreeFile[];
    readonly fileCount: number;
    readonly byteCount: number;
}

interface CopyState {
    fileCount: number;
    byteCount: number;
}

const appletSourceStatSchema = Type.Object(
    {
        isFile: Type.Boolean(),
        isDirectory: Type.Boolean(),
        isSymbolicLink: Type.Boolean(),
        size: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
);
const appletSourceReadOptionsSchema = Type.Object(
    {
        maxBytes: Type.Integer({ minimum: 1, maximum: MAX_APPLET_SOURCE_FILE_BYTES + 1 }),
        noFollow: Type.Literal(true),
    },
    { additionalProperties: false },
);

/**
 * The host supplies this reader for every import. It may be backed by the host
 * filesystem or by an agent/Docker filesystem, but it must enforce the
 * caller's read boundary itself.
 */
export const appletSourceReaderSchema = Type.Object(
    {
        lstat: Type.Function(
            [Type.String({ minLength: 1, maxLength: 4_096 })],
            Type.Promise(appletSourceStatSchema),
        ),
        readdir: Type.Function(
            [Type.String({ minLength: 1, maxLength: 4_096 })],
            Type.Promise(
                Type.Array(Type.String({ minLength: 1, maxLength: 255 }), {
                    maxItems: MAX_APPLET_SOURCE_FILES,
                }),
            ),
        ),
        readFileBuffer: Type.Function(
            [Type.String({ minLength: 1, maxLength: 4_096 }), appletSourceReadOptionsSchema],
            Type.Promise(
                Type.Uint8Array({
                    maxByteLength: MAX_APPLET_SOURCE_FILE_BYTES + 1,
                }),
            ),
        ),
    },
    { additionalProperties: false },
);

export type AppletSourceReader = Static<typeof appletSourceReaderSchema>;
export type AppletSourceReadOptions = Static<typeof appletSourceReadOptionsSchema>;
type AppletSourceStat = Static<typeof appletSourceStatSchema>;

export function assertAppletSourceReader(value: unknown): asserts value is AppletSourceReader {
    if (!Value.Check(appletSourceReaderSchema, value)) {
        throw new Error("The applet source reader is invalid.");
    }
}

/**
 * Copies a static applet source tree into an already-created destination.
 *
 * Every source entry is inspected and bounded before it is copied: symbolic
 * links, special files, oversized files, and source trees large enough to harm
 * the daemon are refused. The source reader owns the read boundary and its
 * final-file no-follow behavior.
 */
export async function copyAppletTree(
    sourcePath: string,
    destinationPath: string,
    bounds: AppletTreeBounds,
    sourceReader: AppletSourceReader,
): Promise<AppletTreeCopyResult> {
    if (!isAbsolute(sourcePath)) {
        throw new Error("The applet source path must be an absolute folder path on this machine.");
    }
    if (!isAbsolute(destinationPath)) {
        throw new Error("The applet destination path must be an absolute folder path.");
    }
    assertAppletSourceReader(sourceReader);
    let sourceFacts;
    try {
        sourceFacts = await sourceReader.lstat(sourcePath);
    } catch {
        throw new Error(`The applet source folder ${JSON.stringify(sourcePath)} does not exist.`);
    }
    assertAppletSourceStat(sourceFacts);
    if (sourceFacts.isSymbolicLink || !sourceFacts.isDirectory) {
        throw new Error(`The applet source ${JSON.stringify(sourcePath)} is not a folder.`);
    }

    const state: CopyState = { fileCount: 0, byteCount: 0 };
    await copyDirectory(sourcePath, destinationPath, bounds, state, sourceReader);
    return { fileCount: state.fileCount, byteCount: state.byteCount };
}

/** Reads a bounded source tree without creating any destination-side files. */
export async function readAppletTree(
    sourcePath: string,
    bounds: AppletTreeBounds,
    sourceReader: AppletSourceReader,
): Promise<AppletTreeReadResult> {
    if (!isAbsolute(sourcePath)) {
        throw new Error("The applet source path must be an absolute folder path on this machine.");
    }
    assertAppletSourceReader(sourceReader);
    let sourceFacts;
    try {
        sourceFacts = await sourceReader.lstat(sourcePath);
    } catch {
        throw new Error(`The applet source folder ${JSON.stringify(sourcePath)} does not exist.`);
    }
    assertAppletSourceStat(sourceFacts);
    if (sourceFacts.isSymbolicLink || !sourceFacts.isDirectory) {
        throw new Error(`The applet source ${JSON.stringify(sourcePath)} is not a folder.`);
    }
    const state: CopyState = { fileCount: 0, byteCount: 0 };
    const files: AppletTreeFile[] = [];
    await readDirectory(sourcePath, "", bounds, state, sourceReader, files);
    return { files, fileCount: state.fileCount, byteCount: state.byteCount };
}

async function copyDirectory(
    sourcePath: string,
    destinationPath: string,
    bounds: AppletTreeBounds,
    state: CopyState,
    sourceReader: AppletSourceReader,
): Promise<void> {
    await mkdir(destinationPath, { recursive: true });
    let entries: readonly string[];
    try {
        entries = await sourceReader.readdir(sourcePath);
    } catch {
        throw new Error(
            `The applet source folder ${JSON.stringify(sourcePath)} could not be read.`,
        );
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
            facts = await sourceReader.lstat(sourceChild);
        } catch {
            throw new Error(
                `The applet source entry ${JSON.stringify(sourceChild)} could not be read.`,
            );
        }
        assertAppletSourceStat(facts);
        if (facts.isSymbolicLink) {
            throw new Error(
                `The applet source may not contain symbolic links (${JSON.stringify(sourceChild)}).`,
            );
        }
        if (facts.isDirectory) {
            await copyDirectory(sourceChild, destinationChild, bounds, state, sourceReader);
            continue;
        }
        if (!facts.isFile) {
            throw new Error(
                `The applet source has an unsupported entry at ${JSON.stringify(sourceChild)}.`,
            );
        }
        state.fileCount += 1;
        if (state.fileCount > bounds.maxFiles) {
            throw new Error("The applet source exceeds the file-count or total-byte import limit.");
        }
        const bytes = await sourceReader.readFileBuffer(sourceChild, {
            maxBytes: bounds.maxFileBytes,
            noFollow: true,
        });
        if (bytes.byteLength > bounds.maxFileBytes) {
            throw new Error(
                `The applet source file ${JSON.stringify(sourceChild)} exceeds the per-file byte limit.`,
            );
        }
        state.byteCount += bytes.byteLength;
        if (state.byteCount > bounds.maxBytes) {
            throw new Error("The applet source exceeds the file-count or total-byte import limit.");
        }
        await writeFile(destinationChild, bytes);
    }
}

async function readDirectory(
    sourcePath: string,
    relativePath: string,
    bounds: AppletTreeBounds,
    state: CopyState,
    sourceReader: AppletSourceReader,
    files: AppletTreeFile[],
): Promise<void> {
    let entries: readonly string[];
    try {
        entries = await sourceReader.readdir(sourcePath);
    } catch {
        throw new Error(
            `The applet source folder ${JSON.stringify(sourcePath)} could not be read.`,
        );
    }
    for (const entry of [...entries].sort()) {
        if (!isSafeSourceEntryName(entry)) {
            throw new Error(
                `The applet source has an unsafe entry named ${JSON.stringify(entry)}.`,
            );
        }
        const sourceChild = join(sourcePath, entry);
        const childRelativePath = relativePath === "" ? entry : join(relativePath, entry);
        let facts;
        try {
            facts = await sourceReader.lstat(sourceChild);
        } catch {
            throw new Error(
                `The applet source entry ${JSON.stringify(sourceChild)} could not be read.`,
            );
        }
        assertAppletSourceStat(facts);
        if (facts.isSymbolicLink) {
            throw new Error(
                `The applet source may not contain symbolic links (${JSON.stringify(sourceChild)}).`,
            );
        }
        if (facts.isDirectory) {
            await readDirectory(sourceChild, childRelativePath, bounds, state, sourceReader, files);
            continue;
        }
        if (!facts.isFile) {
            throw new Error(
                `The applet source has an unsupported entry at ${JSON.stringify(sourceChild)}.`,
            );
        }
        state.fileCount += 1;
        if (state.fileCount > bounds.maxFiles) {
            throw new Error("The applet source exceeds the file-count or total-byte import limit.");
        }
        const bytes = await sourceReader.readFileBuffer(sourceChild, {
            maxBytes: bounds.maxFileBytes,
            noFollow: true,
        });
        if (bytes.byteLength > bounds.maxFileBytes) {
            throw new Error(
                `The applet source file ${JSON.stringify(sourceChild)} exceeds the per-file byte limit.`,
            );
        }
        state.byteCount += bytes.byteLength;
        if (state.byteCount > bounds.maxBytes) {
            throw new Error("The applet source exceeds the file-count or total-byte import limit.");
        }
        files.push({ path: childRelativePath, bytes: Buffer.from(bytes) });
    }
}

function assertAppletSourceStat(value: unknown): asserts value is AppletSourceStat {
    if (!Value.Check(appletSourceStatSchema, value)) {
        throw new Error("The applet source reader returned invalid file facts.");
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
