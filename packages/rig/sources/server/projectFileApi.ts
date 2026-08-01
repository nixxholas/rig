import { createHash } from "node:crypto";

import { isPathInsideWorkspace } from "../agent/context/isPathInsideWorkspace.js";
import type { FileSystemContext } from "../agent/context/FileSystemContext.js";
import type {
    ReadProjectFileResponse,
    WriteProjectFileRequest,
    WriteProjectFileResponse,
} from "../protocol/index.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function readProjectFile(
    fileSystem: FileSystemContext,
    path: string,
): Promise<ReadProjectFileResponse> {
    await assertProjectPath(fileSystem, path);
    const content = await readBoundedFile(fileSystem, path);
    return {
        content: Buffer.from(content).toString("base64"),
        hash: sha256(content),
    };
}

export async function writeProjectFile(
    fileSystem: FileSystemContext,
    request: WriteProjectFileRequest,
): Promise<WriteProjectFileResponse> {
    await assertProjectPath(fileSystem, request.path);
    const content = decodeBase64(request.content);
    if (content.byteLength > MAX_FILE_BYTES) throw new ProjectFileTooLargeError();
    const exists = await fileSystem.exists(request.path);
    if (request.expectedHash === null) {
        if (exists) throw new ProjectFileConflictError("The file already exists.");
    } else {
        if (!exists) throw new ProjectFileConflictError("The file no longer exists.");
        const current = await readBoundedFile(fileSystem, request.path);
        if (sha256(current) !== request.expectedHash) {
            throw new ProjectFileConflictError("The file changed before it could be saved.");
        }
    }
    await fileSystem.writeFile(request.path, content);
    return { hash: sha256(content) };
}

export class ProjectFileConflictError extends Error {}

export class ProjectFileOutsideScopeError extends Error {
    constructor() {
        super("Project file operations cannot access files outside the selected folder.");
    }
}

export class ProjectFileTooLargeError extends Error {
    constructor() {
        super("The file is larger than the 32 MB limit.");
    }
}

async function assertProjectPath(fileSystem: FileSystemContext, path: string): Promise<void> {
    if (!(await isPathInsideWorkspace(fileSystem.cwd, path))) {
        throw new ProjectFileOutsideScopeError();
    }
}

async function readBoundedFile(fileSystem: FileSystemContext, path: string): Promise<Uint8Array> {
    const details = await fileSystem.stat(path);
    if (details.size > MAX_FILE_BYTES) throw new ProjectFileTooLargeError();
    try {
        const content = await fileSystem.readFileBuffer(path, { maxBytes: MAX_FILE_BYTES });
        if (content.byteLength > MAX_FILE_BYTES) throw new ProjectFileTooLargeError();
        return content;
    } catch (error) {
        if (
            error instanceof Error &&
            error.message.includes(`exceeds ${String(MAX_FILE_BYTES)} bytes`)
        ) {
            throw new ProjectFileTooLargeError();
        }
        throw error;
    }
}

function decodeBase64(value: string): Buffer {
    if (
        value.length % 4 !== 0 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
    ) {
        throw new Error("File content must be valid base64.");
    }
    return Buffer.from(value, "base64");
}

function sha256(value: Uint8Array): string {
    return createHash("sha256").update(value).digest("hex");
}
