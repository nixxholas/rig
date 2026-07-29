import { createHash } from "node:crypto";

import type { AgentContext } from "../agent/index.js";
import type {
    ReadSessionFileResponse,
    WriteSessionFileRequest,
    WriteSessionFileResponse,
} from "../protocol/index.js";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export async function readSessionFile(
    context: AgentContext,
    path: string,
): Promise<ReadSessionFileResponse> {
    const details = await context.fs.stat(path);
    if (details.size > MAX_FILE_BYTES) throw new SessionFileTooLargeError();
    const content = await context.fs.readFileBuffer(path);
    if (content.byteLength > MAX_FILE_BYTES) throw new SessionFileTooLargeError();
    return {
        content: Buffer.from(content).toString("base64"),
        hash: sha256(content),
    };
}

export async function writeSessionFile(
    context: AgentContext,
    request: WriteSessionFileRequest,
): Promise<WriteSessionFileResponse> {
    const content = decodeBase64(request.content);
    if (content.byteLength > MAX_FILE_BYTES) throw new SessionFileTooLargeError();
    const exists = await context.fs.exists(request.path);
    if (request.expectedHash === null) {
        if (exists) throw new SessionFileConflictError("The file already exists.");
    } else {
        if (!exists) throw new SessionFileConflictError("The file no longer exists.");
        const current = await context.fs.readFileBuffer(request.path);
        if (sha256(current) !== request.expectedHash) {
            throw new SessionFileConflictError("The file changed before it could be saved.");
        }
    }
    await context.fs.writeFile(request.path, content);
    return { hash: sha256(content) };
}

export class SessionFileConflictError extends Error {}

export class SessionFileTooLargeError extends Error {
    constructor() {
        super("The file is larger than the 32 MB limit.");
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
