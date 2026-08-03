import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import type { FileSystemContext, FileSystemStat } from "../agent/context/FileSystemContext.js";
import { isPathInsideWorkspace } from "../agent/context/isPathInsideWorkspace.js";
import { isProtectedGitControlPath } from "../agent/context/isProtectedGitControlPath.js";
import {
    listFileTreeRequestSchema,
    type FileTreeEntry,
    type ListFileTreeRequest,
    type ListFileTreeResponse,
} from "../protocol/index.js";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PATH_SEGMENTS = 256;
const cursorPayloadSchema = Type.Object(
    {
        after: Type.String({ minLength: 1 }),
        directoryMtimeMs: Type.Number(),
        directorySize: Type.Integer({ minimum: 0 }),
        path: Type.String(),
        version: Type.Literal(1),
    },
    { additionalProperties: false },
);
type CursorPayload = Static<typeof cursorPayloadSchema>;

export async function listFileTree(
    fileSystem: FileSystemContext,
    request: ListFileTreeRequest,
): Promise<ListFileTreeResponse> {
    if (!Value.Check(listFileTreeRequestSchema, request)) {
        throw new FileTreeInvalidRequestError("File-tree settings are invalid.");
    }

    const segments = request.path.length === 0 ? [] : request.path.split("/");
    if (
        segments.length > MAX_PATH_SEGMENTS ||
        segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ) {
        throw new FileTreeInvalidRequestError("The requested file-tree path is invalid.");
    }
    if (segments.some((segment) => isProtectedGitControlPath(segment))) {
        throw new FileTreeProtectedPathError();
    }

    const directory = await resolveDirectory(fileSystem, segments);
    await assertInsideWorkspace(fileSystem, directory);
    const before = await fileSystem.stat(directory);
    if (!before.isDirectory) {
        throw new FileTreeInvalidRequestError("The requested file-tree path is not a directory.");
    }

    const cursor =
        request.cursor === undefined ? undefined : decodeCursor(request.cursor, request.path);
    if (cursor !== undefined && !sameFingerprint(cursor, before)) {
        throw new FileTreeChangedError();
    }

    const limit = request.limit ?? DEFAULT_PAGE_SIZE;
    const visiblePage = await readVisiblePage(fileSystem, directory, cursor?.after, limit);
    const inspectedNames = visiblePage.names;
    const entries = await readEntries(fileSystem, directory, request.path, inspectedNames);

    const after = await fileSystem.stat(directory);
    if (cursor !== undefined && !sameFileSystemFingerprint(before, after)) {
        throw new FileTreeChangedError();
    }

    const lastInspected = inspectedNames.at(-1);
    return {
        entries,
        nextCursor:
            visiblePage.hasMore && lastInspected !== undefined
                ? encodeCursor({
                      after: lastInspected,
                      directoryMtimeMs: normalizedModified(after.mtimeMs),
                      directorySize: normalizedSize(after.size),
                      path: request.path,
                      version: 1,
                  })
                : null,
        path: request.path,
    };
}

async function readVisiblePage(
    fileSystem: FileSystemContext,
    directory: string,
    initialAfter: string | undefined,
    limit: number,
): Promise<{ hasMore: boolean; names: readonly string[] }> {
    const names: string[] = [];
    let after = initialAfter;
    while (names.length <= limit) {
        const rawPage = await fileSystem.readdirPage(directory, {
            ...(after === undefined ? {} : { after }),
            limit: limit + 1,
        });
        let advanced = false;
        for (const name of rawPage.entries) {
            after = name;
            advanced = true;
            if (!isGitDirectoryName(name)) names.push(name);
            if (names.length > limit) break;
        }
        if (names.length > limit) return { hasMore: true, names: names.slice(0, limit) };
        if (!rawPage.hasMore || !advanced) return { hasMore: false, names };
    }
    return { hasMore: false, names };
}

function isGitDirectoryName(name: string): boolean {
    return name.toLowerCase() === ".git";
}

async function resolveDirectory(
    fileSystem: FileSystemContext,
    segments: readonly string[],
): Promise<string> {
    let directory = fileSystem.cwd;
    for (const segment of segments) {
        directory = joinFileSystemPath(directory, segment);
        const facts = await fileSystem.lstat(directory);
        if (facts.isSymbolicLink) throw new FileTreeSymlinkTraversalError();
        if (!facts.isDirectory) {
            throw new FileTreeInvalidRequestError(
                "The requested file-tree path is not a directory.",
            );
        }
    }
    return directory;
}

async function assertInsideWorkspace(
    fileSystem: FileSystemContext,
    directory: string,
): Promise<void> {
    if (
        !(await isPathInsideWorkspace(
            fileSystem.cwd,
            directory,
            async (path) => await fileSystem.realpath(path),
        ))
    ) {
        throw new FileTreeInvalidRequestError(
            "The requested file-tree path is outside the workspace.",
        );
    }
}

async function readEntries(
    fileSystem: FileSystemContext,
    directory: string,
    relativeDirectory: string,
    names: readonly string[],
): Promise<FileTreeEntry[]> {
    const facts = await fileSystem.lstatMany(
        names.map((name) => joinFileSystemPath(directory, name)),
    );
    return names.flatMap((name, index): FileTreeEntry[] => {
        const entryFacts = facts[index];
        if (entryFacts === undefined) return [];
        return [
            {
                modified: normalizedModified(entryFacts.mtimeMs),
                name,
                path: relativeDirectory.length === 0 ? name : `${relativeDirectory}/${name}`,
                size: normalizedSize(entryFacts.size),
                type: entryType(entryFacts),
            },
        ];
    });
}

function joinFileSystemPath(parent: string, child: string): string {
    const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
    return parent.endsWith(separator) ? `${parent}${child}` : `${parent}${separator}${child}`;
}

function entryType(facts: FileSystemStat): FileTreeEntry["type"] {
    if (facts.isSymbolicLink) return "symlink";
    if (facts.isDirectory) return "directory";
    if (facts.isFile) return "file";
    return "other";
}

function normalizedSize(size: number): number {
    return Number.isSafeInteger(size) && size > 0 ? size : 0;
}

function normalizedModified(modified: number): number {
    return Number.isFinite(modified) && modified > 0 ? modified : 0;
}

function sameFingerprint(cursor: CursorPayload, facts: FileSystemStat): boolean {
    return (
        cursor.directoryMtimeMs === normalizedModified(facts.mtimeMs) &&
        cursor.directorySize === normalizedSize(facts.size)
    );
}

function sameFileSystemFingerprint(left: FileSystemStat, right: FileSystemStat): boolean {
    return (
        normalizedModified(left.mtimeMs) === normalizedModified(right.mtimeMs) &&
        normalizedSize(left.size) === normalizedSize(right.size)
    );
}

function encodeCursor(payload: CursorPayload): string {
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string, path: string): CursorPayload {
    try {
        const bytes = Buffer.from(cursor, "base64url");
        if (bytes.toString("base64url") !== cursor) throw new Error("non-canonical cursor");
        const payload: unknown = JSON.parse(bytes.toString("utf8"));
        if (!Value.Check(cursorPayloadSchema, payload) || payload.path !== path) {
            throw new Error("cursor does not match this directory");
        }
        return payload;
    } catch {
        throw new FileTreeInvalidRequestError("The file-tree cursor is invalid.");
    }
}

export class FileTreeInvalidRequestError extends Error {}

export class FileTreeChangedError extends Error {
    constructor() {
        super("The directory changed while it was being listed. Reload it from the beginning.");
    }
}

export class FileTreeProtectedPathError extends Error {
    constructor() {
        super("The file tree does not expose Git control paths.");
    }
}

export class FileTreeSymlinkTraversalError extends Error {
    constructor() {
        super("The file tree cannot traverse a symbolic link.");
    }
}
