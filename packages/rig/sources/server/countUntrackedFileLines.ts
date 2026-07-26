import { open } from "node:fs/promises";

const BINARY_SNIFF_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;

export interface UntrackedFileCount {
    binary: boolean;
    /** Absent when the file was too large, unreadable, or binary. */
    insertions?: number;
    /** True when the file could not be counted and totals must be reported as inexact. */
    inexact: boolean;
}

/**
 * Counts the lines a new file would add.
 *
 * `git diff` never reports untracked files, so the scanner counts them itself. Counting newline
 * bytes alone is wrong: Git treats a final line without a trailing newline as a line, so a one-line
 * file written without one would otherwise report zero insertions.
 *
 * Reads are streamed and bounded. A file that is too large, unreadable, vanished mid-scan, or not a
 * regular file is skipped rather than blocking the scan, and says so through `inexact` so the
 * caller can mark its totals accordingly.
 */
export async function countUntrackedFileLines(
    path: string,
    maximumBytes: number,
): Promise<UntrackedFileCount> {
    let handle;
    try {
        handle = await open(path, "r");
    } catch {
        return { binary: false, inexact: true };
    }
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) return { binary: false, inexact: true };
        if (stats.size > maximumBytes) return { binary: false, inexact: true };

        const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
        let inspected = 0;
        let lines = 0;
        let lastByte: number | undefined;
        for (;;) {
            const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_BYTES, null);
            if (bytesRead === 0) break;
            const chunk = buffer.subarray(0, bytesRead);
            if (inspected < BINARY_SNIFF_BYTES && chunk.includes(0)) {
                return { binary: true, inexact: false };
            }
            inspected += bytesRead;
            for (let index = 0; index < bytesRead; index += 1) {
                if (chunk[index] === 0x0a) lines += 1;
            }
            lastByte = chunk[bytesRead - 1];
        }
        // A trailing byte that is not a newline means the final line is unterminated but real.
        if (lastByte !== undefined && lastByte !== 0x0a) lines += 1;
        return { binary: false, inexact: false, insertions: lines };
    } catch {
        return { binary: false, inexact: true };
    } finally {
        await handle.close().catch(() => undefined);
    }
}
