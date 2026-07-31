import { mkdtemp, mkdir, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
    acquireSqliteProcessLock,
    SqliteProcessLockUnavailableError,
    type SqliteProcessLock,
} from "../acquireSqliteProcessLock.js";

const heldLocks = new Set<SqliteProcessLock>();
const roots = new Set<string>();

afterEach(async () => {
    for (const lock of heldLocks) lock.release();
    heldLocks.clear();
    await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
    roots.clear();
});

describe("SQLite process locks", () => {
    it("excludes a second owner until the first releases the kernel lock", async () => {
        const path = await createLockPath();
        const first = hold(await acquireSqliteProcessLock(path));

        await expect(acquireSqliteProcessLock(path)).rejects.toBeInstanceOf(
            SqliteProcessLockUnavailableError,
        );

        first.release();
        heldLocks.delete(first);
        const second = hold(await acquireSqliteProcessLock(path));
        expect(second.path).toBe(await realpath(path));
        expect((await stat(path)).mode & 0o777).toBe(0o600);
    });

    it("waits asynchronously for an owner that is finishing", async () => {
        const path = await createLockPath();
        const first = hold(await acquireSqliteProcessLock(path));
        const waiting = acquireSqliteProcessLock(path, {
            retryIntervalMs: 1,
            timeoutMs: 1_000,
        });

        queueMicrotask(() => {
            first.release();
            heldLocks.delete(first);
        });

        hold(await waiting);
    });

    it("canonicalizes symlinked parent directories to one ownership boundary", async () => {
        const root = await createRoot();
        const realDirectory = join(root, "real");
        const aliasDirectory = join(root, "alias");
        await mkdir(realDirectory);
        await symlink(realDirectory, aliasDirectory);
        const realPath = join(realDirectory, "database.lock");
        const aliasPath = join(aliasDirectory, "database.lock");
        const first = hold(await acquireSqliteProcessLock(aliasPath));

        expect(first.path).toBe(await realpath(realPath));
        await expect(acquireSqliteProcessLock(realPath)).rejects.toBeInstanceOf(
            SqliteProcessLockUnavailableError,
        );
    });
});

function hold(lock: SqliteProcessLock): SqliteProcessLock {
    heldLocks.add(lock);
    return lock;
}

async function createLockPath(): Promise<string> {
    return join(await createRoot(), "database.lock");
}

async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "rig-sqlite-process-lock-"));
    roots.add(root);
    return root;
}
