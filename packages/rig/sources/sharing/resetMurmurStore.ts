import { rm } from "node:fs/promises";
import { join } from "node:path";

const MURMUR_STORE_FILE_NAME = "sharing-murmur.sqlite";

/** Removes the closed Murmur SQLite store and any SQLite sidecars left after an interrupted run. */
export async function resetMurmurStore(directory: string): Promise<void> {
    const path = join(directory, MURMUR_STORE_FILE_NAME);
    await Promise.all([
        rm(path, { force: true }),
        rm(`${path}-shm`, { force: true }),
        rm(`${path}-wal`, { force: true }),
    ]);
}
