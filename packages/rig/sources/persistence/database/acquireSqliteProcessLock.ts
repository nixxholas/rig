import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";

const DEFAULT_RETRY_INTERVAL_MS = 25;

export interface SqliteProcessLock {
    readonly path: string;
    release(): void;
}

export interface AcquireSqliteProcessLockOptions {
    retryIntervalMs?: number;
    timeoutMs?: number;
}

export class SqliteProcessLockUnavailableError extends Error {
    readonly path: string;

    constructor(path: string) {
        super(`Another process holds the SQLite lock at ${path}.`);
        this.name = "SqliteProcessLockUnavailableError";
        this.path = path;
    }
}

/**
 * Holds an OS-backed SQLite EXCLUSIVE transaction for the lifetime of the returned handle.
 * The kernel releases the lock when the process exits, including after SIGKILL, so ownership
 * never depends on a heartbeat, a PID probe, or deleting a stale marker.
 */
export async function acquireSqliteProcessLock(
    path: string,
    options: AcquireSqliteProcessLockOptions = {},
): Promise<SqliteProcessLock> {
    path = canonicalizeLockPath(path);
    const timeoutMs = Math.max(0, options.timeoutMs ?? 0);
    const retryIntervalMs = Math.max(1, options.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    const deadline = Date.now() + timeoutMs;

    for (;;) {
        const lock = tryAcquireSqliteProcessLock(path);
        if (lock !== undefined) return lock;

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new SqliteProcessLockUnavailableError(path);
        await delay(Math.min(retryIntervalMs, remainingMs));
    }
}

function tryAcquireSqliteProcessLock(path: string): SqliteProcessLock | undefined {
    let client: Database.Database | undefined;
    try {
        const previousUmask = process.umask(0o077);
        try {
            client = new Database(path, { timeout: 0 });
        } finally {
            process.umask(previousUmask);
        }
        chmodSync(path, 0o600);
        client.pragma("journal_mode = DELETE");
        client.exec("BEGIN EXCLUSIVE");
    } catch (error) {
        try {
            client?.close();
        } catch {
            // Preserve the acquisition failure. Closing still asks SQLite to release every lock.
        }
        if (isSqliteLockContention(error)) return undefined;
        throw error;
    }

    let released = false;
    return {
        path,
        release() {
            if (released) return;
            released = true;
            client.close();
        },
    };
}

function canonicalizeLockPath(path: string): string {
    const parent = dirname(path);
    mkdirSync(parent, { mode: 0o700, recursive: true });
    return join(realpathSync(parent), basename(path));
}

function isSqliteLockContention(error: unknown): boolean {
    if (typeof error !== "object" || error === null || !("code" in error)) return false;
    const code = (error as { code?: unknown }).code;
    return (
        typeof code === "string" &&
        (code === "SQLITE_BUSY" ||
            code.startsWith("SQLITE_BUSY_") ||
            code === "SQLITE_LOCKED" ||
            code.startsWith("SQLITE_LOCKED_"))
    );
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}
