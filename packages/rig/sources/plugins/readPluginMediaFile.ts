import { open } from "node:fs/promises";

import { HAPPY_PLUGIN_MAX_MEDIA_BYTES } from "happy-plugins";
import {
    PluginApiRequestError,
    PluginApiRequestTooLargeError,
    PluginWorkspaceOperationError,
    resolvePluginWorkspaceFilePath,
} from "happy-plugins/internal";

/** Reads one regular file after resolving it canonically inside the plugin's writable folder. */
export async function readPluginMediaFile(
    pluginDirectory: string,
    relativePath: string,
): Promise<Buffer> {
    const target = await resolvePluginMediaPath(pluginDirectory, relativePath);
    const file = await open(target, "r");
    try {
        const details = await file.stat();
        if (!details.isFile()) {
            throw new PluginApiRequestError("The requested plugin media path is not a file.");
        }
        if (details.size > HAPPY_PLUGIN_MAX_MEDIA_BYTES) throw mediaTooLargeError();
        const bytes = Buffer.alloc(details.size);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const result = await file.read(bytes, offset, bytes.byteLength - offset, offset);
            if (result.bytesRead === 0) break;
            offset += result.bytesRead;
        }
        const extra = Buffer.alloc(1);
        if ((await file.read(extra, 0, 1, offset)).bytesRead > 0) throw mediaTooLargeError();
        return bytes.subarray(0, offset);
    } finally {
        await file.close();
    }
}

async function resolvePluginMediaPath(
    pluginDirectory: string,
    relativePath: string,
): Promise<string> {
    try {
        return await resolvePluginWorkspaceFilePath(pluginDirectory, relativePath);
    } catch (error) {
        if (!(error instanceof PluginWorkspaceOperationError)) throw error;
        const message = error.message
            .replace("Plugin workspace file paths", "Plugin media paths")
            .replace("The workspace file path", "The plugin media path")
            .replace("The workspace directory", "The plugin data folder")
            .replace("the workspace", "the plugin data folder");
        if (message === error.message) throw error;
        throw new PluginWorkspaceOperationError(message, error.status, error);
    }
}

function mediaTooLargeError(): PluginApiRequestTooLargeError {
    return new PluginApiRequestTooLargeError(
        `Plugin media cannot exceed ${String(HAPPY_PLUGIN_MAX_MEDIA_BYTES)} bytes.`,
    );
}