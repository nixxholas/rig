import { open } from "node:fs/promises";

import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";
import { resolvePluginWorkspaceFilePath } from "./resolvePluginWorkspaceFilePath.js";
import type { ReadWorkspaceFileResponse } from "./types.js";
import { HAPPY_PLUGIN_MAX_FILE_BYTES } from "./types.js";
import { toPluginWorkspaceOperationError } from "./toPluginWorkspaceOperationError.js";

export async function readPluginWorkspaceFile(
    workspaceRoot: string,
    relativePath: string,
): Promise<ReadWorkspaceFileResponse> {
    try {
        const target = await resolvePluginWorkspaceFilePath(workspaceRoot, relativePath);
        const file = await open(target, "r");
        try {
            const details = await file.stat();
            if (!details.isFile()) {
                throw new PluginWorkspaceOperationError(
                    "The requested workspace path is not a file.",
                );
            }
            if (details.size > HAPPY_PLUGIN_MAX_FILE_BYTES) throw fileTooLargeError();
            const content = Buffer.alloc(details.size);
            let bytes = 0;
            while (bytes < content.byteLength) {
                const result = await file.read(content, bytes, content.byteLength - bytes, bytes);
                if (result.bytesRead === 0) break;
                bytes += result.bytesRead;
            }
            const extra = Buffer.alloc(1);
            const extraRead = await file.read(extra, 0, extra.byteLength, bytes);
            if (extraRead.bytesRead > 0) {
                throw new PluginWorkspaceOperationError(
                    "The workspace file changed while it was being read. Try reading it again.",
                );
            }
            return {
                bytes,
                contentBase64: content.subarray(0, bytes).toString("base64"),
            };
        } finally {
            await file.close();
        }
    } catch (error) {
        throw toPluginWorkspaceOperationError(error, "read");
    }
}

function fileTooLargeError(): PluginWorkspaceOperationError {
    return new PluginWorkspaceOperationError(
        `Plugin workspace files cannot exceed ${String(HAPPY_PLUGIN_MAX_FILE_BYTES)} bytes.`,
    );
}
