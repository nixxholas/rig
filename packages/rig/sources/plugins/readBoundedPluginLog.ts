import { open } from "node:fs/promises";

import { Value } from "@sinclair/typebox/value";

import { fileSystemErrorSchema } from "./types.js";

/** Protocol and UI snapshots return only the newest useful portion of the retained log. */
export const MAXIMUM_PLUGIN_LOG_READ_BYTES = 16 * 1024;

export function boundPluginLogText(text: string): { text: string; truncated: boolean } {
    const buffer = Buffer.from(text);
    const truncated = buffer.length > MAXIMUM_PLUGIN_LOG_READ_BYTES;
    return {
        text: decodeRecentUtf8(buffer, MAXIMUM_PLUGIN_LOG_READ_BYTES),
        truncated,
    };
}

export async function readBoundedPluginLog(
    path: string,
): Promise<{ text: string; truncated: boolean }> {
    let file;
    try {
        file = await open(path, "r");
    } catch (error) {
        if (Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT") {
            return { text: "", truncated: false };
        }
        throw error;
    }
    try {
        const { size } = await file.stat();
        const length = Math.min(size, MAXIMUM_PLUGIN_LOG_READ_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, size - length);
        return {
            text: decodeRecentUtf8(buffer.subarray(0, bytesRead), bytesRead),
            truncated: size > MAXIMUM_PLUGIN_LOG_READ_BYTES,
        };
    } finally {
        await file.close();
    }
}

function decodeRecentUtf8(buffer: Buffer, maximumBytes: number): string {
    let start = Math.max(0, buffer.length - maximumBytes);
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString("utf8");
}
