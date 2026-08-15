import { open } from "node:fs/promises";

/** Protocol and UI snapshots return only the newest useful portion of the retained log. */
export const MAXIMUM_WORKLET_LOG_READ_BYTES = 16 * 1024;

export async function readBoundedWorkletLog(
    path: string,
): Promise<{ text: string; truncated: boolean }> {
    let file;
    try {
        file = await open(path, "r");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { text: "", truncated: false };
        }
        throw error;
    }
    try {
        const { size } = await file.stat();
        const length = Math.min(size, MAXIMUM_WORKLET_LOG_READ_BYTES);
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await file.read(buffer, 0, length, size - length);
        return {
            text: decodeRecentUtf8(buffer.subarray(0, bytesRead)),
            truncated: size > MAXIMUM_WORKLET_LOG_READ_BYTES,
        };
    } finally {
        await file.close();
    }
}

function decodeRecentUtf8(buffer: Buffer): string {
    let start = 0;
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString("utf8");
}
