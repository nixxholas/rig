import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { PluginWorkspaceOperationError } from "./PluginWorkspaceOperationError.js";
import { resolvePluginWorkspaceFilePath } from "./resolvePluginWorkspaceFilePath.js";
import type { WriteWorkspaceFileResult } from "./types.js";
import { HAPPY_PLUGIN_MAX_FILE_BYTES } from "./types.js";
import { toPluginWorkspaceOperationError } from "./toPluginWorkspaceOperationError.js";

export async function writePluginWorkspaceFile(
    workspaceRoot: string,
    relativePath: string,
    content: Buffer,
): Promise<WriteWorkspaceFileResult> {
    try {
        if (content.byteLength > HAPPY_PLUGIN_MAX_FILE_BYTES) {
            throw new PluginWorkspaceOperationError(
                `Plugin workspace files cannot exceed ${String(HAPPY_PLUGIN_MAX_FILE_BYTES)} bytes.`,
            );
        }
        const target = await resolvePluginWorkspaceFilePath(workspaceRoot, relativePath);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        return { bytesWritten: content.byteLength };
    } catch (error) {
        throw toPluginWorkspaceOperationError(error, "write");
    }
}
