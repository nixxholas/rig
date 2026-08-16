import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectAvatarStore } from "./ProjectAvatarStore.js";

/** How long an unreferenced avatar is kept, so a rename or a retry can still find its bytes. */
export const AVATAR_GARBAGE_DELAY_MS = 24 * 60 * 60 * 1_000;

const MAX_COLLECTED_PER_PASS = 100;

/**
 * Removes stored avatar bytes no project points at any more.
 *
 * Collection is deliberately late. An avatar that has just been replaced may still be the one a
 * client is showing, and a failed project retry may reach for the picture it stored a moment ago,
 * so a file is only removed once it has been unreferenced for a day.
 */
export async function collectProjectAvatarGarbage(options: {
    referencedHashes: ReadonlySet<string>;
    root: string;
    store: ProjectAvatarStore;
    now: number;
    stopped: () => boolean;
}): Promise<number> {
    let removed = 0;
    let buckets: string[];
    try {
        buckets = await readdir(options.root);
    } catch {
        return 0;
    }
    for (const bucket of buckets) {
        if (options.stopped() || removed >= MAX_COLLECTED_PER_PASS) return removed;
        let files: string[];
        try {
            files = await readdir(join(options.root, bucket));
        } catch {
            continue;
        }
        for (const file of files) {
            if (options.stopped() || removed >= MAX_COLLECTED_PER_PASS) return removed;
            const hash = file.endsWith(".webp") ? file.slice(0, -".webp".length) : undefined;
            if (hash === undefined || !/^[a-f0-9]{64}$/u.test(hash)) continue;
            if (options.referencedHashes.has(hash)) continue;
            try {
                const details = await stat(join(options.root, bucket, file));
                if (options.now - details.mtimeMs < AVATAR_GARBAGE_DELAY_MS) continue;
                await options.store.remove(hash);
                removed += 1;
            } catch {
                // A file that vanished or cannot be read is not this pass's problem.
            }
        }
    }
    return removed;
}
